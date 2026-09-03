import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import acpPackage from "@agentclientprotocol/sdk/package.json" with { type: "json" };
import deepSeekPackage from "@deepseek-ai/dsh-base/package.json" with { type: "json" };
import invalidFixtures from "../protocol/v2/fixtures/invalid.json" with { type: "json" };
import validFixtures from "../protocol/v2/fixtures/valid.json" with { type: "json" };
import { AdapterError, AdapterErrorCode } from "./errors.js";
import { ACP_SDK_VERSION, DEEPSEEK_HARNESS_VERSION } from "./protocol.js";
import { checkRuntimeComposition } from "./runtime.js";
import { validateFixtureCorpus } from "./schema.js";

export interface ReadinessReport {
  stateDir: string;
  stateDirExists: boolean;
}

function isMissingPathError(args: { error: unknown }): boolean {
  return (
    args.error instanceof Error &&
    "code" in args.error &&
    (args.error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

async function nearestExistingPath(args: { path: string }): Promise<string> {
  let candidate = args.path;
  while (true) {
    try {
      await stat(candidate);
      return candidate;
    } catch (error) {
      if (!isMissingPathError({ error })) throw error;
      await rejectDanglingSymlink({ path: candidate });
      const parent = dirname(candidate);
      if (parent === candidate) throw error;
      candidate = parent;
    }
  }
}

async function rejectDanglingSymlink(args: { path: string }): Promise<void> {
  try {
    await lstat(args.path);
  } catch (error) {
    if (isMissingPathError({ error })) return;
    throw error;
  }
  throw new AdapterError({
    code: AdapterErrorCode.StatePath,
    message: `State path contains a dangling symbolic link: ${args.path}`,
  });
}

async function validateStateDirectory(args: { stateDir: string }): Promise<boolean> {
  if (!isAbsolute(args.stateDir)) {
    throw new AdapterError({
      code: AdapterErrorCode.StatePath,
      message: "--state-dir must be an absolute path",
    });
  }

  try {
    const state = await stat(args.stateDir);
    if (!state.isDirectory()) {
      throw new AdapterError({
        code: AdapterErrorCode.StatePath,
        message: `State path is not a directory: ${args.stateDir}`,
      });
    }
    await access(args.stateDir, constants.R_OK | constants.W_OK | constants.X_OK);
    return true;
  } catch (error) {
    if (!isMissingPathError({ error })) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError({
        code: AdapterErrorCode.StatePath,
        message: `State directory is not usable: ${args.stateDir}`,
        cause: error,
      });
    }
    await rejectDanglingSymlink({ path: args.stateDir });
  }

  try {
    const parent = await nearestExistingPath({ path: dirname(args.stateDir) });
    const parentState = await stat(parent);
    if (!parentState.isDirectory()) {
      throw new Error(`Existing state-path ancestor is not a directory: ${parent}`);
    }
    await access(parent, constants.W_OK | constants.X_OK);
    return false;
  } catch (error) {
    throw new AdapterError({
      code: AdapterErrorCode.StatePath,
      message: `State directory cannot be created below an accessible parent: ${args.stateDir}`,
      cause: error,
    });
  }
}

function validateProtocolCorpus(): void {
  const validResults = validateFixtureCorpus({ corpus: validFixtures });
  const invalidResults = validateFixtureCorpus({ corpus: invalidFixtures });
  if (!validResults.every((result) => result.valid) || !invalidResults.every((result) => !result.valid)) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: "Protocol fixture corpus does not match the canonical schema",
    });
  }
}

export async function checkReadiness(args: { stateDir: string }): Promise<ReadinessReport> {
  if (deepSeekPackage.version !== DEEPSEEK_HARNESS_VERSION) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `Expected DeepSeek Harness ${DEEPSEEK_HARNESS_VERSION}, found ${deepSeekPackage.version}`,
    });
  }
  if (acpPackage.version !== ACP_SDK_VERSION) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `Expected ACP SDK ${ACP_SDK_VERSION}, found ${acpPackage.version}`,
    });
  }

  const basePatch = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"));
  try {
    await access(basePatch, constants.R_OK);
  } catch (error) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: "The pinned DeepSeek base profile patch is not readable",
      cause: error,
    });
  }

  validateProtocolCorpus();
  await checkRuntimeComposition({ stateDir: args.stateDir });
  return {
    stateDir: args.stateDir,
    stateDirExists: await validateStateDirectory({ stateDir: args.stateDir }),
  };
}
