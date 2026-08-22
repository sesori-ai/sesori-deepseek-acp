import { constants } from "node:fs";
import { access, lstat, stat } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import { applyEntryPatches, type PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import { boot, loadOverlayPatches } from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";
import runtimeConfig from "../runtime/cordis.json" with { type: "json" };
import { AdapterError, AdapterErrorCode } from "./errors.js";

const BIN_NAME = "sesori-deepseek-acp";
export const RUNTIME_READY_KEY = "sesoriRuntimeReady";
const runtimeConfigPath = fileURLToPath(new URL("../runtime/cordis.json", import.meta.url));
const basePatchPath = fileURLToPath(import.meta.resolve("@deepseek-ai/dsh-base/cordis.patch.yml"));

// Importing the JSON makes TypeScript copy the package-owned root beside built output.
void runtimeConfig;

declare module "@deepseek-ai/cordis" {
  interface Context {
    sesoriRuntimeReady?: true;
  }
}

export interface RuntimePaths {
  stateDir: string;
  sessions: string;
  attachmentsHome: string;
  queryDatabase: string;
  spills: string;
}

export interface RuntimeProfile {
  entries: EntryOptions[];
  patches: PatchOptions[];
  paths: RuntimePaths;
}

function statePaths(args: { stateDir: string }): RuntimePaths {
  return {
    stateDir: args.stateDir,
    sessions: join(args.stateDir, "sessions"),
    attachmentsHome: join(args.stateDir, "attachments-home"),
    queryDatabase: join(args.stateDir, "query", "sessions.sqlite"),
    spills: join(args.stateDir, "spills"),
  };
}

function adapterPatches(args: { paths: RuntimePaths; workspaceRoot: string }): PatchOptions[] {
  return [
    { id: "session-persistence-jsonl", config: { root: args.paths.sessions } },
    { id: "attachment-local", config: { dshHome: args.paths.attachmentsHome } },
    {
      id: "session-query-sqlite",
      config: { path: args.paths.queryDatabase, openAt: "never" },
    },
    { id: "spill-local", config: { root: args.paths.spills } },
    { id: "session-telemetry-otel", disabled: true },
    { id: "hmr", disabled: true },
    {
      id: "sandbox-policy",
      config: { mode: "workspace-write", workspaceRoot: args.workspaceRoot },
    },
    { id: "approval", config: { policy: "ask" } },
  ];
}

function findEntry(args: { entries: EntryOptions[]; id: string }): EntryOptions {
  const entry = args.entries.find((candidate) => candidate.id === args.id);
  if (entry !== undefined) return entry;
  throw new AdapterError({
    code: AdapterErrorCode.Readiness,
    message: `The pinned DeepSeek profile is missing required row ${args.id}`,
  });
}

function assertEntry(args: {
  entries: EntryOptions[];
  id: string;
  config?: unknown;
  disabled?: boolean;
}): void {
  const entry = findEntry({ entries: args.entries, id: args.id });
  if (args.disabled !== undefined && entry.disabled !== args.disabled) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek profile row ${args.id} has an unsafe enabled state`,
    });
  }
  if (args.config !== undefined && JSON.stringify(entry.config) !== JSON.stringify(args.config)) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek profile row ${args.id} does not match the required configuration`,
    });
  }
}

function assertComposition(args: {
  entries: EntryOptions[];
  paths: RuntimePaths;
  workspaceRoot: string;
}): void {
  assertEntry({
    entries: args.entries,
    id: "session-persistence-jsonl",
    config: { root: args.paths.sessions },
  });
  assertEntry({
    entries: args.entries,
    id: "attachment-local",
    config: { dshHome: args.paths.attachmentsHome },
  });
  assertEntry({
    entries: args.entries,
    id: "session-query-sqlite",
    config: { path: args.paths.queryDatabase, openAt: "never" },
  });
  assertEntry({ entries: args.entries, id: "spill-local", config: { root: args.paths.spills } });
  assertEntry({ entries: args.entries, id: "session-telemetry-otel", disabled: true });
  assertEntry({ entries: args.entries, id: "hmr", disabled: true });
  assertEntry({
    entries: args.entries,
    id: "sandbox-policy",
    config: { mode: "workspace-write", workspaceRoot: args.workspaceRoot },
  });
  assertEntry({ entries: args.entries, id: "approval", config: { policy: "ask" } });

  const forbidden = args.entries.find((entry) => {
    const name = entry.name ?? "";
    return (
      name === "@deepseek-ai/dsh-acp" ||
      name.startsWith("@deepseek-ai/dsh-host-") ||
      name.includes("frontend-static") ||
      name.includes("webserver") ||
      name.includes("web-fetch-http") ||
      name.includes("console-logger")
    );
  });
  if (forbidden !== undefined) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek profile unexpectedly mounts ${forbidden.name ?? forbidden.id}`,
    });
  }
}

export function composeRuntimeProfile(args: {
  stateDir: string;
  workspaceRoot?: string;
}): RuntimeProfile {
  const paths = statePaths({ stateDir: args.stateDir });
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const patches = [
    ...loadOverlayPatches(BIN_NAME, basePatchPath),
    ...adapterPatches({ paths, workspaceRoot }),
  ];
  const warnings: string[] = [];
  const entries = applyEntryPatches([], patches, (message, ...values) => {
    warnings.push(`${message} ${values.map(String).join(" ")}`.trim());
  });
  if (warnings.length > 0) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The pinned DeepSeek profile rejected the adapter overlay: ${warnings.join("; ")}`,
    });
  }
  assertComposition({ entries, paths, workspaceRoot });
  return { entries, patches, paths };
}

function inheritedEnvironment(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function assertReadableIfPresent(args: { path: string }): Promise<void> {
  try {
    await lstat(args.path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return;
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `DeepSeek configuration is not readable: ${args.path}`,
      cause: error,
    });
  }

  try {
    const state = await stat(args.path);
    if (!state.isFile()) throw new Error("expected a regular file");
    await access(args.path, constants.R_OK);
  } catch (error) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `DeepSeek configuration is not readable: ${args.path}`,
      cause: error,
    });
  }
}

export async function checkRuntimeComposition(args: {
  stateDir: string;
  workspaceRoot?: string;
}): Promise<RuntimeProfile> {
  const profile = composeRuntimeProfile(args);
  const dshHome = resolveDshHome();
  await assertReadableIfPresent({ path: join(dshHome, "settings.yaml") });
  await assertReadableIfPresent({ path: join(dshHome, ".credentials.yaml") });
  return profile;
}

export async function bootRuntime(args: {
  stateDir: string;
  workspaceRoot?: string;
  prepare?: (context: Context) => Promise<void> | void;
}): Promise<Context> {
  const profile = composeRuntimeProfile(args);
  const context = await boot(BIN_NAME, runtimeConfigPath, profile.patches, async (bootContext) => {
    bootContext.provide(
      DSH_LAUNCH_ENVIRONMENT_KEY,
      createLaunchEnvironmentSnapshot([{ source: "process", values: inheritedEnvironment() }]),
    );
    await args.prepare?.(bootContext);
  });
  if (context.get("loader") !== undefined) context.provide(RUNTIME_READY_KEY, true);
  return context;
}
