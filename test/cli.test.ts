import { chmod, mkdir, mkdtemp, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import packageJson from "../package.json" with { type: "json" };
import { runCli } from "../src/cli.ts";
import {
  AdapterError,
  AdapterErrorCode,
  AdapterExitCode,
  formatDiagnostic,
} from "../src/errors.ts";
import {
  ADAPTER_VERSION,
  DEEPSEEK_HARNESS_VERSION,
} from "../src/protocol.ts";

const originalDshHome = process.env.DSH_HOME;
let testHomeRoot: string;

beforeEach(async () => {
  testHomeRoot = await mkdtemp(join(tmpdir(), "sesori-deepseek-cli-home-"));
  process.env.DSH_HOME = join(testHomeRoot, "home");
});

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
  await rm(testHomeRoot, { recursive: true, force: true });
});

interface CliResult {
  exitCode: AdapterExitCode;
  stdout: string;
  stderr: string;
}

function capture(args: { stream: PassThrough }): () => string {
  let content = "";
  args.stream.setEncoding("utf8");
  args.stream.on("data", (chunk: string) => {
    content += chunk;
  });
  return () => content;
}

async function invoke(args: { argv: readonly string[] }): Promise<CliResult> {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  const stdout = capture({ stream: output });
  const stderr = capture({ stream: diagnostics });
  const exitCode = await runCli({ argv: args.argv, input, output, diagnostics });
  return { exitCode, stdout: stdout(), stderr: stderr() };
}

describe("adapter CLI", () => {
  it("reports the adapter and pinned harness versions", async () => {
    const result = await invoke({ argv: ["--version"] });
    expect(result).toEqual({
      exitCode: AdapterExitCode.Success,
      stdout: "sesori-deepseek-acp/0.1.6 deepseek-harness/0.1.5-rc.2 acp/1\n",
      stderr: "",
    });
    expect(packageJson.version).toBe(ADAPTER_VERSION);
    expect(result.stdout).toContain(DEEPSEEK_HARNESS_VERSION);
  });

  it("rejects missing and relative state paths as usage errors", async () => {
    const missing = await invoke({ argv: ["check"] });
    const relative = await invoke({ argv: ["serve", "--state-dir", "relative/path"] });
    expect(missing.exitCode).toBe(AdapterExitCode.Usage);
    expect(relative.exitCode).toBe(AdapterExitCode.Usage);
    expect(missing.stderr).toContain("check requires --state-dir");
    expect(relative.stderr).toContain("must be an absolute path");
  });

  it("checks a future state directory without creating or writing it", async () => {
    const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-acp-"));
    const stateDir = join(root, "future", "state");
    try {
      const result = await invoke({ argv: ["check", "--state-dir", stateDir] });
      expect(result.exitCode).toBe(AdapterExitCode.Success);
      expect(JSON.parse(result.stdout)).toMatchObject({
        status: "ok",
        stateDir,
        stateDirExists: false,
      });
      expect(result.stderr).toBe("");
      await expect(stat(stateDir)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(stat(join(root, "future"))).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("includes every bounded aggregate fallback cause in diagnostics", () => {
    const diagnostic = formatDiagnostic({
      error: new AdapterError({
        code: AdapterErrorCode.Readiness,
        message: "both runtime profiles failed",
        cause: new AggregateError(
          [
            new AggregateError(
              Array.from({ length: 4 }, (_, index) => new Error(
                `nested persisted failure ${String(index)} ${"x".repeat(1_000)}`,
              )),
              "persisted profile marker",
            ),
            new Error("in-memory profile marker"),
          ],
          "profile attempts failed",
        ),
      }),
    });

    expect(diagnostic).toContain("persisted profile marker");
    expect(diagnostic).toContain("in-memory profile marker");
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
  });

  it("retains an ordinary cause stack that fits the diagnostic budget", () => {
    const cause = new Error("single cause marker");
    cause.stack = `Error: single cause marker\n${"at synthetic frame\n".repeat(60)}single cause tail`;

    const diagnostic = formatDiagnostic({
      error: new AdapterError({
        code: AdapterErrorCode.Readiness,
        message: "runtime failed",
        cause,
      }),
    });

    expect(diagnostic).toContain("single cause tail");
    expect(diagnostic.length).toBeGreaterThan(512);
    expect(diagnostic.length).toBeLessThanOrEqual(2_048);
  });

  it("reports an in-memory fallback without failing readiness", async () => {
    const home = process.env.DSH_HOME;
    if (home === undefined) throw new Error("expected isolated DeepSeek home");
    await mkdir(home, { recursive: true });
    await writeFile(join(home, "profiles"), "occupied by a file");
    const stateDir = join(testHomeRoot, "future-state");

    const result = await invoke({ argv: ["check", "--state-dir", stateDir] });

    expect(result.exitCode).toBe(AdapterExitCode.Success);
    expect(JSON.parse(result.stdout)).toMatchObject({ status: "ok", stateDir });
    expect(result.stderr).toContain(
      "warning: readiness_error: The Sesori DeepSeek profile is unavailable; using the pinned in-memory profile",
    );
  });

  it("rejects a state path that is a file", async () => {
    const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-acp-"));
    const stateFile = join(root, "state-file");
    try {
      await writeFile(stateFile, "synthetic");
      const result = await invoke({ argv: ["check", "--state-dir", stateFile] });
      expect(result.exitCode).toBe(AdapterExitCode.Failure);
      expect(result.stderr).toContain("State path is not a directory");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== "win32")("rejects an unwritable state parent", async () => {
    const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-acp-"));
    try {
      await chmod(root, 0o500);
      const result = await invoke({ argv: ["check", "--state-dir", join(root, "state")] });
      expect(result.exitCode).toBe(AdapterExitCode.Failure);
      expect(result.stderr).toContain("cannot be created below an accessible parent");
    } finally {
      await chmod(root, 0o700);
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects dangling symlinks in a missing-looking state path", async () => {
    const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-acp-"));
    const dangling = join(root, "dangling");
    try {
      await symlink(join(root, "missing-target"), dangling, "dir");
      for (const stateDir of [dangling, join(dangling, "state")]) {
        const result = await invoke({ argv: ["check", "--state-dir", stateDir] });
        expect(result.exitCode).toBe(AdapterExitCode.Failure);
        expect(result.stderr).toContain("dangling symbolic link");
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
