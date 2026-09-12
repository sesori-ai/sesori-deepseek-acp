import { constants, existsSync } from "node:fs";
import { access, lstat, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { Context } from "@deepseek-ai/cordis";
import type { EntryOptions } from "@deepseek-ai/cordis-plugin-loader";
import { applyEntryPatches, type PatchOptions } from "@deepseek-ai/cordis-plugin-include";
import {
  boot,
  healProfilesModuleFallback,
  initProfile,
  loadOverlayPatches,
  loadProfile,
  resolveProfileDir,
} from "@deepseek-ai/dsh-app-boot";
import { resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  createLaunchEnvironmentSnapshot,
  DSH_LAUNCH_ENVIRONMENT_KEY,
} from "@deepseek-ai/dsh-launch-environment";
import runtimeConfig from "../runtime/cordis.json" with { type: "json" };
import { AdapterError, AdapterErrorCode } from "./errors.js";

const BIN_NAME = "sesori-deepseek-acp";
const BASE_BUNDLE_NAME = "@deepseek-ai/dsh-base";
const SESORI_PROFILE_NAME = "sesori";
const PROFILE_ROOT_FILENAME = "cordis.yml";
const PROFILE_ROOT = "[]\n";
const RESERVED_PROFILE_ENTRY_IDS = new Set([
  "session-persistence-jsonl",
  "attachment-local",
  "session-query-sqlite",
  "storage-json",
  "spill-local",
  "session-telemetry-otel",
  "hmr",
  "sandbox-policy",
  "approval",
  "tool-ask-user",
]);
export const RUNTIME_READY_KEY = "sesoriRuntimeReady";
const runtimeConfigPath = fileURLToPath(new URL("../runtime/cordis.json", import.meta.url));
const basePatchPath = fileURLToPath(import.meta.resolve(`${BASE_BUNDLE_NAME}/cordis.patch.yml`));

export const RuntimeProfileOrigin = {
  InMemory: "in_memory",
  Persisted: "persisted",
} as const;
export type RuntimeProfileOrigin =
  | { kind: typeof RuntimeProfileOrigin.InMemory }
  | { kind: typeof RuntimeProfileOrigin.Persisted; path: string };

export interface RuntimeProfileFallback {
  error: AdapterError;
}

export type RuntimeProfileFallbackReporter = (args: RuntimeProfileFallback) => void;

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
  storages: string;
  spills: string;
}

export interface RuntimeProfile {
  bareModuleBaseUrl: string;
  configPath: string;
  entries: EntryOptions[];
  origin: RuntimeProfileOrigin;
  patches: PatchOptions[];
  paths: RuntimePaths;
}

function statePaths(args: { stateDir: string }): RuntimePaths {
  return {
    stateDir: args.stateDir,
    sessions: join(args.stateDir, "sessions"),
    attachmentsHome: join(args.stateDir, "attachments-home"),
    queryDatabase: join(args.stateDir, "query", "sessions.sqlite"),
    storages: join(args.stateDir, "storages"),
    spills: join(args.stateDir, "spills"),
  };
}

function adapterPatches(args: { paths: RuntimePaths; workspaceRoot: string }): PatchOptions[] {
  return [
    {
      id: "session-persistence-jsonl",
      disabled: false,
      config: { root: args.paths.sessions },
    },
    {
      id: "attachment-local",
      disabled: false,
      config: { dshHome: args.paths.attachmentsHome },
    },
    {
      id: "session-query-sqlite",
      disabled: false,
      config: { path: args.paths.queryDatabase, openAt: "never" },
    },
    { id: "storage-json", disabled: false, config: { root: args.paths.storages } },
    { id: "spill-local", disabled: false, config: { root: args.paths.spills } },
    { id: "session-telemetry-otel", disabled: true },
    { id: "hmr", disabled: true },
    {
      id: "sandbox-policy",
      disabled: false,
      config: { mode: "workspace-write", workspaceRoot: args.workspaceRoot },
    },
    { id: "approval", disabled: false, config: { policy: "ask" } },
    { insert: [{ id: "tool-ask-user", name: "@deepseek-ai/dsh-tool-ask-user" }] },
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
  enabled?: boolean;
}): void {
  const entry = findEntry({ entries: args.entries, id: args.id });
  if (args.disabled !== undefined && entry.disabled !== args.disabled) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek profile row ${args.id} has an unsafe enabled state`,
    });
  }
  if (args.enabled === true && entry.disabled === true) {
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

function assertReservedEntryIdsUnique(args: { entries: EntryOptions[] }): void {
  const counts = new Map<string, number>();
  for (const entry of args.entries) {
    if (!RESERVED_PROFILE_ENTRY_IDS.has(entry.id)) continue;
    counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
  }
  const duplicates = [...counts.entries()]
    .filter((entry) => entry[1] > 1)
    .map((entry) => entry[0]);
  if (duplicates.length === 0) return;
  throw new AdapterError({
    code: AdapterErrorCode.Readiness,
    message: `The DeepSeek profile duplicates reserved Sesori rows: ${duplicates.join(", ")}`,
  });
}

function assertComposition(args: {
  entries: EntryOptions[];
  paths: RuntimePaths;
  workspaceRoot: string;
}): void {
  assertReservedEntryIdsUnique({ entries: args.entries });
  assertEntry({
    entries: args.entries,
    id: "session-persistence-jsonl",
    config: { root: args.paths.sessions },
    enabled: true,
  });
  assertEntry({
    entries: args.entries,
    id: "attachment-local",
    config: { dshHome: args.paths.attachmentsHome },
    enabled: true,
  });
  assertEntry({
    entries: args.entries,
    id: "session-query-sqlite",
    config: { path: args.paths.queryDatabase, openAt: "never" },
    enabled: true,
  });
  assertEntry({
    entries: args.entries,
    id: "storage-json",
    config: { root: args.paths.storages },
    enabled: true,
  });
  assertEntry({
    entries: args.entries,
    id: "spill-local",
    config: { root: args.paths.spills },
    enabled: true,
  });
  assertEntry({ entries: args.entries, id: "session-telemetry-otel", disabled: true });
  assertEntry({ entries: args.entries, id: "hmr", disabled: true });
  assertEntry({
    entries: args.entries,
    id: "sandbox-policy",
    config: { mode: "workspace-write", workspaceRoot: args.workspaceRoot },
    enabled: true,
  });
  assertEntry({
    entries: args.entries,
    id: "approval",
    config: { policy: "ask" },
    enabled: true,
  });
  assertEntry({ entries: args.entries, id: "tool-ask-user", enabled: true });

  const forbidden = args.entries.find((entry) => {
    const name = entry.name ?? "";
    return entry.disabled !== true && (
      name === "@deepseek-ai/dsh-acp" ||
      name.startsWith("@deepseek-ai/dsh-host-") ||
      name.includes("frontend-static") ||
      name.includes("webserver") ||
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

function adapterInstallAnchor(): string {
  const candidates = [
    fileURLToPath(new URL("../package.json", import.meta.url)),
    fileURLToPath(new URL("../../package.json", import.meta.url)),
  ];
  const anchor = candidates.find((candidate) => existsSync(candidate));
  if (anchor !== undefined) return anchor;
  throw new AdapterError({
    code: AdapterErrorCode.Readiness,
    message: "The DeepSeek adapter package manifest is not readable",
  });
}

function composeRuntimeProfileLayers(args: {
  configPath: string;
  layers: PatchOptions[][];
  origin: RuntimeProfileOrigin;
  stateDir: string;
  workspaceRoot?: string;
}): RuntimeProfile {
  const paths = statePaths({ stateDir: args.stateDir });
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const patches = [
    ...args.layers.flat(),
    ...adapterPatches({ paths, workspaceRoot }),
  ];
  const warnings: string[] = [];
  const entries = applyEntryPatches([], structuredClone(patches), (message, ...values) => {
    warnings.push(`${message} ${values.map(String).join(" ")}`.trim());
  });
  if (warnings.length > 0) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek runtime profile rejected the adapter overlay: ${warnings.join("; ")}`,
    });
  }
  assertComposition({ entries, paths, workspaceRoot });
  return {
    bareModuleBaseUrl: pathToFileURL(args.configPath).href,
    configPath: args.configPath,
    entries,
    origin: args.origin,
    patches,
    paths,
  };
}

export function composeRuntimeProfile(args: {
  stateDir: string;
  workspaceRoot?: string;
}): RuntimeProfile {
  return composeRuntimeProfileLayers({
    configPath: runtimeConfigPath,
    layers: [loadOverlayPatches(BIN_NAME, basePatchPath)],
    origin: { kind: RuntimeProfileOrigin.InMemory },
    stateDir: args.stateDir,
    ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
  });
}

async function ensureProfileRoot(args: { path: string }): Promise<void> {
  try {
    await writeFile(args.path, PROFILE_ROOT, { encoding: "utf8", flag: "wx" });
    return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException | null)?.code !== "EEXIST") throw error;
  }
  if (await readFile(args.path, "utf8") !== PROFILE_ROOT) {
    throw new Error(`The Sesori profile root must contain only ${JSON.stringify(PROFILE_ROOT)}`);
  }
}

async function composePersistedRuntimeProfile(args: {
  stateDir: string;
  workspaceRoot?: string;
}): Promise<RuntimeProfile> {
  const home = resolveDshHome();
  const profilePath = resolveProfileDir(SESORI_PROFILE_NAME, home);
  const installAnchor = adapterInstallAnchor();
  initProfile(profilePath, [BASE_BUNDLE_NAME], "startup");
  const configPath = join(profilePath, PROFILE_ROOT_FILENAME);
  await ensureProfileRoot({ path: configPath });
  const profile = loadProfile(BIN_NAME, SESORI_PROFILE_NAME, installAnchor, home);
  const composed = composeRuntimeProfileLayers({
    configPath,
    layers: [...profile.layers.map((layer) => layer.patches), profile.patches],
    origin: { kind: RuntimeProfileOrigin.Persisted, path: profilePath },
    stateDir: args.stateDir,
    ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
  });
  await healProfilesModuleFallback({ home, installAnchor, profile });
  return composed;
}

function fallbackError(args: { error: unknown }): AdapterError {
  return new AdapterError({
    code: AdapterErrorCode.Readiness,
    message: "The Sesori DeepSeek profile is unavailable; using the pinned in-memory profile",
    cause: args.error,
  });
}

function failedFallback(args: { persistedError: unknown; inMemoryError: unknown }): AdapterError {
  return new AdapterError({
    code: AdapterErrorCode.Readiness,
    message: "Neither the Sesori DeepSeek profile nor the pinned in-memory profile is usable",
    cause: new AggregateError(
      [args.persistedError, args.inMemoryError],
      "Persisted and in-memory DeepSeek profile attempts failed",
    ),
  });
}

export async function resolveRuntimeProfile(args: {
  stateDir: string;
  workspaceRoot?: string;
  onProfileFallback?: RuntimeProfileFallbackReporter;
}): Promise<RuntimeProfile> {
  try {
    return await composePersistedRuntimeProfile({
      stateDir: args.stateDir,
      ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
    });
  } catch (persistedError) {
    let profile: RuntimeProfile;
    try {
      profile = composeRuntimeProfile({
        stateDir: args.stateDir,
        ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
      });
    } catch (inMemoryError) {
      throw failedFallback({ persistedError, inMemoryError });
    }
    args.onProfileFallback?.({ error: fallbackError({ error: persistedError }) });
    return profile;
  }
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
  onProfileFallback?: RuntimeProfileFallbackReporter;
}): Promise<RuntimeProfile> {
  const profile = await resolveRuntimeProfile({
    stateDir: args.stateDir,
    ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
    ...(args.onProfileFallback === undefined ? {} : { onProfileFallback: args.onProfileFallback }),
  });
  const dshHome = resolveDshHome();
  await assertReadableIfPresent({ path: join(dshHome, "settings.yaml") });
  await assertReadableIfPresent({ path: join(dshHome, ".credentials.yaml") });
  return profile;
}

async function startRuntimeProfile(args: {
  profile: RuntimeProfile;
  prepare?: (context: Context) => Promise<void> | void;
  onPrepared: () => void;
}): Promise<Context> {
  return boot(
    BIN_NAME,
    args.profile.configPath,
    args.profile.patches,
    async (bootContext) => {
      bootContext.provide(
        DSH_LAUNCH_ENVIRONMENT_KEY,
        createLaunchEnvironmentSnapshot([{ source: "process", values: inheritedEnvironment() }]),
      );
      await args.prepare?.(bootContext);
      args.onPrepared();
    },
    args.profile.bareModuleBaseUrl,
  );
}

function markRuntimeReady(args: { context: Context }): Context {
  if (args.context.get("loader") !== undefined) args.context.provide(RUNTIME_READY_KEY, true);
  return args.context;
}

export async function bootRuntime(args: {
  stateDir: string;
  workspaceRoot?: string;
  prepare?: (context: Context) => Promise<void> | void;
  onProfileFallback?: RuntimeProfileFallbackReporter;
}): Promise<Context> {
  const profile = await resolveRuntimeProfile({
    stateDir: args.stateDir,
    ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
    ...(args.onProfileFallback === undefined ? {} : { onProfileFallback: args.onProfileFallback }),
  });
  let prepareCompleted = false;
  try {
    return markRuntimeReady({
      context: await startRuntimeProfile({
        profile,
        ...(args.prepare === undefined ? {} : { prepare: args.prepare }),
        onPrepared: () => {
          prepareCompleted = true;
        },
      }),
    });
  } catch (persistedError) {
    if (
      profile.origin.kind !== RuntimeProfileOrigin.Persisted ||
      !prepareCompleted
    ) {
      throw persistedError;
    }

    const inMemoryProfile = composeRuntimeProfile({
      stateDir: args.stateDir,
      ...(args.workspaceRoot === undefined ? {} : { workspaceRoot: args.workspaceRoot }),
    });
    prepareCompleted = false;
    try {
      const context = markRuntimeReady({
        context: await startRuntimeProfile({
          profile: inMemoryProfile,
          ...(args.prepare === undefined ? {} : { prepare: args.prepare }),
          onPrepared: () => {
            prepareCompleted = true;
          },
        }),
      });
      args.onProfileFallback?.({ error: fallbackError({ error: persistedError }) });
      return context;
    } catch (inMemoryError) {
      throw failedFallback({ persistedError, inMemoryError });
    }
  }
}
