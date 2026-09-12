import { constants, existsSync, readFileSync, statSync } from "node:fs";
import { access, lstat, readFile, stat, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { isAbsolute, join, relative, resolve } from "node:path";
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
import { resolve as resolvePackageExports } from "resolve.exports";
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
const RESERVED_PROFILE_ENTRY_NAMES = new Map([
  ["agent", "@deepseek-ai/dsh-agent"],
  ["subagent", "@deepseek-ai/dsh-subagent"],
  ["session-persistence-jsonl", "@deepseek-ai/dsh-session-persistence-jsonl"],
  ["attachment-local", "@deepseek-ai/dsh-attachment-local"],
  ["session-query-sqlite", "@deepseek-ai/dsh-session-query-sqlite"],
  ["storage-json", "@deepseek-ai/dsh-storage-json"],
  ["spill-local", "@deepseek-ai/dsh-spill-local"],
  ["session-telemetry-otel", "@deepseek-ai/dsh-session-telemetry-otel"],
  ["hmr", "@deepseek-ai/cordis-plugin-hmr"],
  ["sandbox-policy", "@deepseek-ai/dsh-sandbox-policy"],
  ["approval", "@deepseek-ai/dsh-user-approval"],
  ["tool-ask-user", "@deepseek-ai/dsh-tool-ask-user"],
]);
const RESERVED_PROFILE_ENTRY_IDS = new Set(RESERVED_PROFILE_ENTRY_NAMES.keys());
const RESERVED_PROFILE_ENTRY_IDS_BY_NAME = new Map(
  [...RESERVED_PROFILE_ENTRY_NAMES].map(([id, name]) => [name, id]),
);
const PINNED_RESERVED_PROFILE_ENTRY_MODULES = new Map(
  [...RESERVED_PROFILE_ENTRY_NAMES].map(([id, name]) => [
    id,
    fileURLToPath(import.meta.resolve(name)),
  ]),
);
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
    { id: "agent", name: "@deepseek-ai/dsh-agent", disabled: false },
    { id: "subagent", name: "@deepseek-ai/dsh-subagent", disabled: false },
    {
      id: "session-persistence-jsonl",
      name: "@deepseek-ai/dsh-session-persistence-jsonl",
      disabled: false,
      config: { root: args.paths.sessions },
    },
    {
      id: "attachment-local",
      name: "@deepseek-ai/dsh-attachment-local",
      disabled: false,
      config: { dshHome: args.paths.attachmentsHome },
    },
    {
      id: "session-query-sqlite",
      name: "@deepseek-ai/dsh-session-query-sqlite",
      disabled: false,
      config: { path: args.paths.queryDatabase, openAt: "never" },
    },
    {
      id: "storage-json",
      name: "@deepseek-ai/dsh-storage-json",
      disabled: false,
      config: { root: args.paths.storages },
    },
    {
      id: "spill-local",
      name: "@deepseek-ai/dsh-spill-local",
      disabled: false,
      config: { root: args.paths.spills },
    },
    {
      id: "session-telemetry-otel",
      name: "@deepseek-ai/dsh-session-telemetry-otel",
      disabled: true,
    },
    { id: "hmr", name: "@deepseek-ai/cordis-plugin-hmr", disabled: true },
    {
      id: "sandbox-policy",
      name: "@deepseek-ai/dsh-sandbox-policy",
      disabled: false,
      config: { mode: "workspace-write", workspaceRoot: args.workspaceRoot },
    },
    {
      id: "approval",
      name: "@deepseek-ai/dsh-user-approval",
      disabled: false,
      config: { policy: "ask" },
    },
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
  const expectedName = RESERVED_PROFILE_ENTRY_NAMES.get(args.id);
  if (expectedName === undefined || entry.name !== expectedName) {
    throw new AdapterError({
      code: AdapterErrorCode.Readiness,
      message: `The DeepSeek profile row ${args.id} does not use the required plugin`,
    });
  }
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

interface ProfileEntryLocation {
  enabled: boolean;
  entry: EntryOptions;
}

function profileEntryLocations(args: { entries: EntryOptions[] }): ProfileEntryLocation[] {
  const locations: ProfileEntryLocation[] = [];
  const pending = args.entries.map((entry) => ({ enabled: true, entry }));
  const visited = new Set<EntryOptions>();
  let index = 0;
  while (index < pending.length) {
    const location = pending[index];
    index += 1;
    if (location === undefined) continue;
    if (visited.has(location.entry)) {
      throw new AdapterError({
        code: AdapterErrorCode.Readiness,
        message: "The DeepSeek profile contains a cyclic or repeated group entry",
      });
    }
    visited.add(location.entry);
    const enabled = location.enabled && location.entry.disabled !== true;
    locations.push({ enabled, entry: location.entry });
    if (location.entry.group === true && Array.isArray(location.entry.config)) {
      pending.push(
        ...(location.entry.config as EntryOptions[]).map((entry) => ({ enabled, entry })),
      );
    }
  }
  return locations;
}

function assertReservedEntryIdsUnique(args: { entries: EntryOptions[] }): void {
  const counts = new Map<string, number>();
  for (const { enabled, entry } of profileEntryLocations({ entries: args.entries })) {
    if (RESERVED_PROFILE_ENTRY_IDS.has(entry.id)) {
      counts.set(entry.id, (counts.get(entry.id) ?? 0) + 1);
    }
    const reservedId = RESERVED_PROFILE_ENTRY_IDS_BY_NAME.get(entry.name);
    if (enabled && reservedId !== undefined && reservedId !== entry.id) {
      throw new AdapterError({
        code: AdapterErrorCode.Readiness,
        message: `The DeepSeek profile mounts reserved plugin ${entry.name} under alternate row ${entry.id}`,
      });
    }
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
  assertEntry({ entries: args.entries, id: "agent", enabled: true });
  assertEntry({ entries: args.entries, id: "subagent", enabled: true });
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

  const forbidden = profileEntryLocations({ entries: args.entries }).find(({ enabled, entry }) => {
    const name = entry.name ?? "";
    return enabled && (
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
      message: `The DeepSeek profile unexpectedly mounts ${forbidden.entry.name ?? forbidden.entry.id}`,
    });
  }
}

interface BarePackageSpecifier {
  packageName: string;
  subpath: string;
}

function parseBarePackageSpecifier(args: { name: string }): BarePackageSpecifier | undefined {
  if (args.name.startsWith(".") || args.name.includes(":") || isAbsolute(args.name)) {
    return undefined;
  }
  const parts = args.name.split("/");
  const packagePartCount = args.name.startsWith("@") ? 2 : 1;
  if (parts.length < packagePartCount) return undefined;
  const packageName = parts.slice(0, packagePartCount).join("/");
  const subpathParts = parts.slice(packagePartCount);
  return {
    packageName,
    subpath: subpathParts.length === 0 ? "." : `./${subpathParts.join("/")}`,
  };
}

function packageDirectory(args: { anchor: string; packageName: string }): string | undefined {
  for (const searchPath of createRequire(args.anchor).resolve.paths(args.packageName) ?? []) {
    const candidate = join(searchPath, args.packageName);
    if (existsSync(join(candidate, "package.json"))) return candidate;
  }
  return undefined;
}

function resolvePackageEntry(args: {
  anchor: string;
  packageName: string;
  subpath: string;
}): string | undefined {
  const directory = packageDirectory({ anchor: args.anchor, packageName: args.packageName });
  if (directory === undefined) return undefined;
  const manifest = JSON.parse(readFileSync(join(directory, "package.json"), "utf8")) as {
    exports?: unknown;
  };
  if (manifest.exports === undefined) {
    const specifier = args.subpath === "." ? directory : join(directory, args.subpath.slice(2));
    return createRequire(args.anchor).resolve(specifier);
  }

  const candidates = resolvePackageExports(
    { name: args.packageName, exports: manifest.exports },
    args.subpath,
  );
  for (const candidate of candidates ?? []) {
    const entry = resolve(directory, candidate);
    const relativeEntry = relative(directory, entry);
    if (!candidate.startsWith("./") || /^\.\.(?:[\\/]|$)/u.test(relativeEntry)) {
      throw new Error(
        `Package ${args.packageName} export ${args.subpath} resolves outside its package`,
      );
    }
    if (existsSync(entry) && statSync(entry).isFile()) return entry;
  }
  return undefined;
}

function resolveProfileEntryModules(args: {
  adapterInstallAnchor: string;
  entries: EntryOptions[];
  profileInstallAnchor: string;
}): EntryOptions[] {
  const entries = structuredClone(args.entries);
  for (const { entry } of profileEntryLocations({ entries })) {
    const pinnedModule = PINNED_RESERVED_PROFILE_ENTRY_MODULES.get(entry.id);
    if (pinnedModule !== undefined) {
      entry.name = pinnedModule;
      continue;
    }
    const bare = parseBarePackageSpecifier({ name: entry.name });
    if (bare === undefined) continue;
    const anchors = bare.packageName.startsWith("@deepseek-ai/")
      ? [args.adapterInstallAnchor, args.profileInstallAnchor]
      : [args.profileInstallAnchor, args.adapterInstallAnchor];
    const resolvedEntry = anchors
      .map((anchor) => resolvePackageEntry({ anchor, ...bare }))
      .find((candidate) => candidate !== undefined);
    if (resolvedEntry === undefined) {
      throw new AdapterError({
        code: AdapterErrorCode.Readiness,
        message: `The DeepSeek profile cannot resolve plugin ${entry.name}`,
      });
    }
    entry.name = resolvedEntry;
  }
  return entries;
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
  adapterInstallAnchor: string;
  bareModuleBaseUrl: string;
  configPath: string;
  layers: PatchOptions[][];
  origin: RuntimeProfileOrigin;
  profileInstallAnchor: string;
  stateDir: string;
  workspaceRoot?: string;
}): RuntimeProfile {
  const paths = statePaths({ stateDir: args.stateDir });
  const workspaceRoot = args.workspaceRoot ?? process.cwd();
  const patches = [
    ...args.layers.flat(),
    ...adapterPatches({ paths, workspaceRoot }),
  ];
  for (const patch of patches) {
    if (patch.insert !== undefined) profileEntryLocations({ entries: patch.insert });
  }
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
    bareModuleBaseUrl: args.bareModuleBaseUrl,
    configPath: args.configPath,
    entries,
    origin: args.origin,
    patches: [{
      insert: resolveProfileEntryModules({
        adapterInstallAnchor: args.adapterInstallAnchor,
        entries,
        profileInstallAnchor: args.profileInstallAnchor,
      }),
    }],
    paths,
  };
}

export function composeRuntimeProfile(args: {
  stateDir: string;
  workspaceRoot?: string;
}): RuntimeProfile {
  const installAnchor = adapterInstallAnchor();
  return composeRuntimeProfileLayers({
    adapterInstallAnchor: installAnchor,
    bareModuleBaseUrl: pathToFileURL(runtimeConfigPath).href,
    configPath: runtimeConfigPath,
    layers: [loadOverlayPatches(BIN_NAME, basePatchPath)],
    origin: { kind: RuntimeProfileOrigin.InMemory },
    profileInstallAnchor: installAnchor,
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
    adapterInstallAnchor: installAnchor,
    bareModuleBaseUrl: pathToFileURL(configPath).href,
    configPath: runtimeConfigPath,
    layers: [...profile.layers.map((layer) => layer.patches), profile.patches],
    origin: { kind: RuntimeProfileOrigin.Persisted, path: profilePath },
    profileInstallAnchor: join(profilePath, "package.json"),
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
  abortSignal?: AbortSignal;
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
      !prepareCompleted ||
      args.abortSignal?.aborted === true
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
