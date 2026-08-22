import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { defaultDshHome, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import { afterEach, describe, expect, it } from "vitest";
import {
  bootRuntime,
  checkRuntimeComposition,
  composeRuntimeProfile,
} from "../src/runtime.ts";
import { serveStdio } from "../src/server.ts";

const originalDshHome = process.env.DSH_HOME;
const originalApiKey = process.env.DEEPSEEK_API_KEY;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-runtime-"));
  roots.push(root);
  return root;
}

afterEach(async () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DeepSeek runtime composition", () => {
  it("isolates mutable state and fixes deployment policy", () => {
    const profile = composeRuntimeProfile({
      stateDir: "/synthetic/state",
      workspaceRoot: "/synthetic/project-a",
    });
    const entries = new Map(profile.entries.map((entry) => [entry.id, entry]));

    expect(profile.paths).toEqual({
      stateDir: "/synthetic/state",
      sessions: "/synthetic/state/sessions",
      attachmentsHome: "/synthetic/state/attachments-home",
      queryDatabase: "/synthetic/state/query/sessions.sqlite",
      spills: "/synthetic/state/spills",
    });
    expect(entries.get("session-telemetry-otel")?.disabled).toBe(true);
    expect(entries.get("hmr")?.disabled).toBe(true);
    expect(entries.get("sandbox-policy")?.config).toEqual({
      mode: "workspace-write",
      workspaceRoot: "/synthetic/project-a",
    });
    expect(entries.get("approval")?.config).toEqual({ policy: "ask" });
    expect(entries.get("settings")?.config).toBeUndefined();
    expect(entries.get("credentials")?.config).toBeUndefined();
    expect([...entries.values()].some((entry) => entry.name === "@deepseek-ai/dsh-acp")).toBe(
      false,
    );
  });

  it("uses DeepSeek's default and custom home resolution", async () => {
    delete process.env.DSH_HOME;
    expect(resolveDshHome()).toBe(defaultDshHome());

    const root = await tempRoot();
    const home = join(root, "custom-home");
    await cp(new URL("./fixtures/dsh-home", import.meta.url), home, { recursive: true });
    process.env.DSH_HOME = home;
    const profile = await checkRuntimeComposition({ stateDir: join(root, "state") });

    expect(profile.paths.stateDir).toBe(join(root, "state"));
    expect(await readFile(join(home, "settings.yaml"), "utf8")).toContain("synthetic.invalid");
  });

  it("boots the full profile without network or normal-home writes", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const projectA = join(root, "project-a");
    const projectB = join(root, "project-b");
    await cp(new URL("./fixtures/dsh-home", import.meta.url), home, { recursive: true });
    await Promise.all([mkdir(projectA), mkdir(projectB)]);
    process.env.DSH_HOME = home;
    process.env.DEEPSEEK_API_KEY = "synthetic-key";

    const before = await readdir(home);
    const settingsBefore = await readFile(join(home, "settings.yaml"), "utf8");
    const context = await bootRuntime({ stateDir, workspaceRoot: projectA });
    try {
      const credentials = context.get("credentials") as {
        resolve(ref: string): Promise<{ source: string; value: string } | undefined>;
      };
      const sandboxPolicy = context.get("sandboxPolicy") as {
        defaultMode: string;
        resolve(request: { session: object }): { mode: string; workspaceRoot: string };
      };
      const approval = context.get("approval") as { config: { policy?: string } };
      const persistence = context.get("sessionPersistence") as { root: string };
      const attachments = context.get("attachments") as { root: string };
      const query = context.get("sessionQuery") as { config: { path: string; openAt: string } };
      const spills = context.get("spillStore") as { root: string };

      expect(context.get("sessions")).toBeDefined();
      expect(persistence.root).toBe(join(stateDir, "sessions"));
      expect(attachments.root).toBe(join(stateDir, "attachments-home", "attachments", "v1"));
      expect(query.config).toMatchObject({
        path: join(stateDir, "query", "sessions.sqlite"),
        openAt: "never",
      });
      expect(spills.root).toBe(join(stateDir, "spills"));
      expect(context.get("sessionTelemetry")).toBeUndefined();
      expect(context.get("hmr")).toBeUndefined();
      expect(await credentials.resolve("DEEPSEEK_API_KEY")).toEqual({
        source: "env",
        value: "synthetic-key",
      });
      expect(sandboxPolicy.defaultMode).toBe("workspace-write");
      expect(
        sandboxPolicy.resolve({
          session: { id: "synthetic-session", events: [], header: { cwd: projectB } },
        }).workspaceRoot,
      ).toBe(await realpath(projectB));
      expect(approval.config.policy).toBe("ask");
    } finally {
      await context.fiber.dispose();
    }

    expect(await readdir(home)).toEqual(before);
    await expect(readFile(join(home, "settings.yaml"), "utf8")).resolves.toBe(settingsBefore);
  });

  it("boots without credentials and does not make a model request", async () => {
    const root = await tempRoot();
    process.env.DSH_HOME = join(root, "absent-home");
    delete process.env.DEEPSEEK_API_KEY;

    const context = await bootRuntime({ stateDir: join(root, "state") });
    try {
      const credentials = context.get("credentials") as {
        resolve(ref: string): Promise<unknown>;
      };
      await expect(credentials.resolve("DEEPSEEK_API_KEY")).resolves.toBeUndefined();
    } finally {
      await context.fiber.dispose();
    }
  });

  it("mounts ACP only after the full profile is ready", async () => {
    const root = await tempRoot();
    process.env.DSH_HOME = join(root, "home");
    delete process.env.DEEPSEEK_API_KEY;
    const input = new PassThrough();
    const output = new PassThrough();
    const diagnostics = new PassThrough();
    let stdout = "";
    output.setEncoding("utf8");
    output.on("data", (chunk: string) => {
      stdout += chunk;
    });

    const completion = serveStdio({
      stateDir: join(root, "state"),
      input,
      output,
      diagnostics,
    });
    input.end(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "full-runtime",
        method: "initialize",
        params: {
          protocolVersion: PROTOCOL_VERSION,
          clientCapabilities: {},
          clientInfo: { name: "synthetic-client", version: "1.0.0" },
        },
      })}\n`,
    );
    await completion;

    expect(stdout.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(stdout)).toMatchObject({
      jsonrpc: "2.0",
      id: "full-runtime",
      result: { protocolVersion: PROTOCOL_VERSION },
    });
  });
});
