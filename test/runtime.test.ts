import { cp, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { PassThrough } from "node:stream";
import { zstdCompressSync } from "node:zlib";
import { PROTOCOL_VERSION, type AgentSideConnection, type SessionNotification } from "@agentclientprotocol/sdk";
import { defaultDshHome, resolveDshHome } from "@deepseek-ai/dsh-home-paths";
import {
  SESSION_FORMAT_VERSION,
  Session,
  SessionId,
  SessionLogOffset,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  bootRuntime,
  checkRuntimeComposition,
  composeRuntimeProfile,
  resolveRuntimeProfile,
  RuntimeProfileOrigin,
  type RuntimeProfileFallback,
} from "../src/runtime.ts";
import { serveStdio } from "../src/server.ts";
import { DurableSessionAgent } from "../src/sessions.ts";
import { createMemorySubagentBindingStore } from "../src/subagent_bindings.ts";

const originalDshHome = process.env.DSH_HOME;
const originalApiKey = process.env.DEEPSEEK_API_KEY;
const roots: string[] = [];

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sesori-deepseek-runtime-"));
  roots.push(root);
  return root;
}

function projectStorageKey(path: string): string {
  let readable = "";
  let separatorRun = false;
  for (const character of path) {
    if (character === "/" || character === "\\" || character === ":") {
      if (!separatorRun) readable += "-";
      separatorRun = true;
    } else if (character !== "~" && /^[A-Za-z0-9._-]$/u.test(character)) {
      readable += character;
      separatorRun = false;
    } else {
      readable += `~${character.charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")}`;
      separatorRun = false;
    }
  }
  return `--${(readable.replace(/^-+/u, "") || "root").slice(0, 251)}--`;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalDshHome === undefined) delete process.env.DSH_HOME;
  else process.env.DSH_HOME = originalDshHome;
  if (originalApiKey === undefined) delete process.env.DEEPSEEK_API_KEY;
  else process.env.DEEPSEEK_API_KEY = originalApiKey;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("DeepSeek runtime composition", () => {
  it("isolates mutable state and fixes deployment policy", () => {
    const stateDir = resolve("synthetic-state");
    const workspaceRoot = resolve("synthetic-project-a");
    const profile = composeRuntimeProfile({
      stateDir,
      workspaceRoot,
    });
    const entries = new Map(profile.entries.map((entry) => [entry.id, entry]));

    expect(profile.origin).toEqual({ kind: RuntimeProfileOrigin.InMemory });
    expect(profile.paths).toEqual({
      stateDir,
      sessions: join(stateDir, "sessions"),
      attachmentsHome: join(stateDir, "attachments-home"),
      queryDatabase: join(stateDir, "query", "sessions.sqlite"),
      storages: join(stateDir, "storages"),
      spills: join(stateDir, "spills"),
    });
    expect(entries.get("session-telemetry-otel")?.disabled).toBe(true);
    expect(entries.get("hmr")?.disabled).toBe(true);
    expect(entries.get("sandbox-policy")?.config).toEqual({
      mode: "workspace-write",
      workspaceRoot,
    });
    expect(entries.get("approval")?.config).toEqual({ policy: "ask" });
    expect(entries.get("tool-ask-user")).toMatchObject({
      name: "@deepseek-ai/dsh-tool-ask-user",
    });
    expect(entries.get("tool-ask-user")?.disabled).not.toBe(true);
    expect(entries.get("web")?.disabled).not.toBe(true);
    expect(entries.get("web-search-deepseek")?.disabled).not.toBe(true);
    expect(entries.get("web-fetch-http")?.disabled).not.toBe(true);
    expect(entries.get("tool-web")?.disabled).not.toBe(true);
    expect(entries.get("settings")?.config).toBeUndefined();
    expect(entries.get("credentials")?.config).toBeUndefined();
    expect([...entries.values()].some((entry) => entry.name === "@deepseek-ai/dsh-acp")).toBe(
      false,
    );
  });

  it("uses DeepSeek's home resolution and initializes the Sesori profile", async () => {
    delete process.env.DSH_HOME;
    expect(resolveDshHome()).toBe(defaultDshHome());

    const root = await tempRoot();
    const home = join(root, "custom-home");
    await cp(new URL("./fixtures/dsh-home", import.meta.url), home, { recursive: true });
    process.env.DSH_HOME = home;
    const profile = await checkRuntimeComposition({ stateDir: join(root, "state") });
    const profilePath = join(home, "profiles", "sesori");
    const manifest = JSON.parse(await readFile(join(profilePath, "package.json"), "utf8")) as {
      dsh: { profile: { bundles: string[]; patchReload: string } };
    };

    expect(profile.origin).toEqual({ kind: RuntimeProfileOrigin.Persisted, path: profilePath });
    expect(profile.configPath).toBe(join(profilePath, "cordis.yml"));
    expect(profile.paths.stateDir).toBe(join(root, "state"));
    expect(manifest.dsh.profile).toEqual({
      bundles: ["@deepseek-ai/dsh-base"],
      patchReload: "startup",
    });
    await expect(readFile(join(profilePath, "cordis.yml"), "utf8")).resolves.toBe("[]\n");
    await expect(readFile(join(profilePath, "cordis.patch.yml"), "utf8")).resolves.toContain(
      "Your patch layer",
    );
    await expect(readFile(join(profilePath, "pnpm-workspace.yaml"), "utf8")).resolves.toContain(
      "nodeLinker: hoisted",
    );
    expect(await readFile(join(home, "settings.yaml"), "utf8")).toContain("synthetic.invalid");
  });

  it("loads a plugin bundle installed in the Sesori profile", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;

    const initialized = await resolveRuntimeProfile({ stateDir });
    if (initialized.origin.kind !== RuntimeProfileOrigin.Persisted) {
      throw new Error("expected persisted Sesori profile");
    }
    const packageName = "synthetic-sesori-profile-plugin";
    const packagePath = join(initialized.origin.path, "node_modules", packageName);
    await mkdir(packagePath, { recursive: true });
    await Promise.all([
      writeFile(
        join(packagePath, "package.json"),
        `${JSON.stringify({
          name: packageName,
          version: "1.0.0",
          type: "module",
          exports: "./index.js",
          dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }, null, 2)}\n`,
      ),
      writeFile(
        join(packagePath, "cordis.patch.yml"),
        `- id: approval\n  disabled: true\n- insert:\n    - id: synthetic-profile-plugin\n      name: '${packageName}'\n`,
      ),
      writeFile(
        join(packagePath, "index.js"),
        `const name = "synthetic-profile-plugin";\nconst inject = [];\nfunction apply() { globalThis.__sesoriSyntheticProfilePlugin = true; }\nexport { apply, inject, name };\n`,
      ),
    ]);
    const manifestPath = join(initialized.origin.path, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[]; patchReload: string } };
    };
    manifest.dependencies[packageName] = "1.0.0";
    manifest.dsh.profile.bundles.push(packageName);
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const loaded = await resolveRuntimeProfile({ stateDir });
    expect(loaded.origin).toEqual({
      kind: RuntimeProfileOrigin.Persisted,
      path: initialized.origin.path,
    });
    expect(loaded.entries).toContainEqual(
      expect.objectContaining({
        id: "synthetic-profile-plugin",
        name: packageName,
      }),
    );
    expect(loaded.entries.find((entry) => entry.id === "approval")?.disabled).toBe(false);

    const globals = globalThis as typeof globalThis & {
      __sesoriSyntheticProfilePlugin?: true;
    };
    const fallbacks: RuntimeProfileFallback[] = [];
    const context = await bootRuntime({
      stateDir,
      onProfileFallback: (fallback) => fallbacks.push(fallback),
    });
    try {
      expect(fallbacks).toEqual([]);
      expect(globals.__sesoriSyntheticProfilePlugin).toBe(true);
      expect(context.get("sessionTelemetry")).toBeUndefined();
      expect(context.get("hmr")).toBeUndefined();
    } finally {
      delete globals.__sesoriSyntheticProfilePlugin;
      await context.fiber.dispose();
    }
  });

  it("falls back when the Sesori profile cannot be created", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home);
    await writeFile(join(home, "profiles"), "occupied by a file");
    process.env.DSH_HOME = home;

    const fallbacks: RuntimeProfileFallback[] = [];
    const profile = await resolveRuntimeProfile({
      stateDir: join(root, "state"),
      onProfileFallback: (fallback) => fallbacks.push(fallback),
    });

    expect(profile.origin).toEqual({ kind: RuntimeProfileOrigin.InMemory });
    expect(fallbacks).toHaveLength(1);
    expect(fallbacks[0]?.error.message).toBe(
      "The Sesori DeepSeek profile is unavailable; using the pinned in-memory profile",
    );
    expect(fallbacks[0]?.error.cause).toBeInstanceOf(Error);
    await expect(readFile(join(home, "profiles"), "utf8")).resolves.toBe("occupied by a file");
  });

  it("falls back when a profile duplicates a reserved Sesori row", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    process.env.DSH_HOME = home;

    const initialized = await resolveRuntimeProfile({ stateDir });
    if (initialized.origin.kind !== RuntimeProfileOrigin.Persisted) {
      throw new Error("expected persisted Sesori profile");
    }
    await writeFile(
      join(initialized.origin.path, "cordis.patch.yml"),
      "- insert:\n    - id: approval\n      name: '@deepseek-ai/dsh-user-approval'\n      config: []\n",
    );

    const fallbacks: RuntimeProfileFallback[] = [];
    const profile = await resolveRuntimeProfile({
      stateDir,
      onProfileFallback: (fallback) => fallbacks.push(fallback),
    });

    expect(profile.origin).toEqual({ kind: RuntimeProfileOrigin.InMemory });
    expect(fallbacks).toHaveLength(1);
    expect((fallbacks[0]?.error.cause as Error | undefined)?.message).toContain(
      "duplicates reserved Sesori rows: approval",
    );
  });

  it("falls back when a profile replaces a reserved row plugin", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    process.env.DSH_HOME = home;

    const initialized = await resolveRuntimeProfile({ stateDir });
    if (initialized.origin.kind !== RuntimeProfileOrigin.Persisted) {
      throw new Error("expected persisted Sesori profile");
    }
    const packageName = "synthetic-replacement-bundle";
    const packagePath = join(initialized.origin.path, "node_modules", packageName);
    await mkdir(packagePath, { recursive: true });
    await Promise.all([
      writeFile(
        join(packagePath, "package.json"),
        `${JSON.stringify({
          name: packageName,
          version: "1.0.0",
          dsh: { bundle: { patch: "./cordis.patch.yml" } },
        }, null, 2)}\n`,
      ),
      writeFile(
        join(packagePath, "cordis.patch.yml"),
        `- insert:
    - id: session-persistence-jsonl
      name: '@deepseek-ai/dsh-session-persistence-jsonl'
    - id: attachment-local
      name: '@deepseek-ai/dsh-attachment-local'
    - id: session-query-sqlite
      name: '@deepseek-ai/dsh-session-query-sqlite'
    - id: storage-json
      name: '@deepseek-ai/dsh-storage-json'
    - id: spill-local
      name: '@deepseek-ai/dsh-spill-local'
    - id: session-telemetry-otel
      name: '${packageName}'
    - id: hmr
      name: '@deepseek-ai/cordis-plugin-hmr'
    - id: sandbox-policy
      name: '@deepseek-ai/dsh-sandbox-policy'
    - id: approval
      name: '@deepseek-ai/dsh-user-approval'
`,
      ),
    ]);
    const manifestPath = join(initialized.origin.path, "package.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      dependencies: Record<string, string>;
      dsh: { profile: { bundles: string[] } };
    };
    manifest.dependencies[packageName] = "1.0.0";
    manifest.dsh.profile.bundles = [packageName];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    const fallbacks: RuntimeProfileFallback[] = [];
    const profile = await resolveRuntimeProfile({
      stateDir,
      onProfileFallback: (fallback) => fallbacks.push(fallback),
    });

    expect(profile.origin).toEqual({ kind: RuntimeProfileOrigin.InMemory });
    expect(fallbacks).toHaveLength(1);
    expect((fallbacks[0]?.error.cause as Error | undefined)?.message).toContain(
      "rejected the adapter overlay",
    );
    expect((fallbacks[0]?.error.cause as Error | undefined)?.message).toContain(
      "session-telemetry-otel",
    );
  });

  it("falls back when an installed profile plugin cannot boot", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;

    const initialized = await resolveRuntimeProfile({ stateDir });
    if (initialized.origin.kind !== RuntimeProfileOrigin.Persisted) {
      throw new Error("expected persisted Sesori profile");
    }
    await writeFile(
      join(initialized.origin.path, "cordis.patch.yml"),
      "- insert:\n    - id: unavailable-profile-plugin\n      name: 'unavailable-profile-plugin'\n",
    );

    const cancellationFallbacks: RuntimeProfileFallback[] = [];
    await expect(bootRuntime({
      stateDir,
      abortSignal: AbortSignal.abort(),
      onProfileFallback: (fallback) => cancellationFallbacks.push(fallback),
    })).rejects.toThrow("plugin tree failed to load");
    expect(cancellationFallbacks).toEqual([]);

    const fallbacks: RuntimeProfileFallback[] = [];
    const context = await bootRuntime({
      stateDir,
      onProfileFallback: (fallback) => fallbacks.push(fallback),
    });
    try {
      expect(context.get("sessions")).toBeDefined();
      expect(fallbacks).toHaveLength(1);
      expect(fallbacks[0]?.error.cause).toBeInstanceOf(Error);
    } finally {
      await context.fiber.dispose();
    }
  });

  it("rejects a dangling configuration symlink", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    await mkdir(home);
    await symlink(join(root, "missing-settings.yaml"), join(home, "settings.yaml"));
    process.env.DSH_HOME = home;

    await expect(checkRuntimeComposition({ stateDir: join(root, "state") })).rejects.toThrow(
      "DeepSeek configuration is not readable",
    );
  });

  it("boots the full profile without network or settings writes", async () => {
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
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    let context: Awaited<ReturnType<typeof bootRuntime>> | undefined;
    try {
      context = await bootRuntime({ stateDir, workspaceRoot: projectA });
      expect(fetchSpy).not.toHaveBeenCalled();
      const credentials = context.get("credentials") as {
        resolve(ref: string): Promise<{ source: string; value: string } | undefined>;
      };
      const sandboxPolicy = context.get("sandboxPolicy") as {
        defaultMode: string;
        resolve(request: { session: object }): { mode: string; workspaceRoot: string };
      };
      const approval = context.get("approval") as { config: { policy?: string } };
      const persistence = context.get("sessionPersistence") as unknown as { root: string };
      const attachments = context.get("attachments") as unknown as { root: string };
      const query = context.get("sessionQuery") as unknown as { config: { path: string; openAt: string } };
      const spills = context.get("spillStore") as { root: string };

      expect(context.get("sessions")).toBeDefined();
      const tools = context.get("tools") as { schemas(): { name: string }[] };
      expect(tools.schemas()).toContainEqual(expect.objectContaining({ name: "ask_user_question" }));
      expect(tools.schemas()).toContainEqual(expect.objectContaining({ name: "web_search" }));
      expect(tools.schemas()).toContainEqual(expect.objectContaining({ name: "web_fetch" }));
      expect(persistence.root).toBe(join(stateDir, "sessions"));
      const attachmentRelativePath = relative(join(stateDir, "attachments-home"), attachments.root);
      expect(isAbsolute(attachmentRelativePath)).toBe(false);
      expect(
        attachmentRelativePath === ".." || attachmentRelativePath.startsWith(`..${sep}`),
      ).toBe(false);
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
      const sandboxSession = Session.create(
        SessionId("synthetic-session"),
        [],
        {
          version: SESSION_FORMAT_VERSION,
          id: SessionId("synthetic-session"),
          createdAt: 1,
          cwd: projectB,
          isSeeded: false,
        },
        SessionLogOffset(0),
      );
      expect(sandboxPolicy.resolve({ session: sandboxSession }).workspaceRoot).toBe(await realpath(projectB));
      expect(approval.config.policy).toBe("ask");
    } finally {
      await context?.fiber.dispose();
      fetchSpy.mockRestore();
    }

    expect((await readdir(home)).sort()).toEqual([...before, "profiles"].sort());
    await expect(readFile(join(home, "settings.yaml"), "utf8")).resolves.toBe(settingsBefore);
  });

  it("exposes and requests canonical DeepSeek Flash metadata without catalog network I/O", async () => {
    const root = await tempRoot();
    const home = join(root, "home");
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await cp(new URL("./fixtures/dsh-home", import.meta.url), home, { recursive: true });
    await mkdir(project);
    process.env.DSH_HOME = home;
    delete process.env.DEEPSEEK_API_KEY;

    const fetchSpy = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled"));
    const context = await bootRuntime({ stateDir, workspaceRoot: project });
    const requests: { provider: string; model: string; reasoningEffort?: string }[] = [];
    const stopStream = context.on("llm/stream", (options) => {
      requests.push({
        provider: options.provider,
        model: options.model,
        ...(options.reasoningEffort === undefined ? {} : { reasoningEffort: String(options.reasoningEffort) }),
      });
      return (async function* () {
        yield { type: "block-start" as const, index: 0, blockType: "text" as const };
        yield { type: "text-delta" as const, index: 0, text: "synthetic answer" };
        yield { type: "block-end" as const, index: 0, block: { type: "text" as const, text: "synthetic answer" } };
        yield { type: "finish" as const, reason: { kind: "stop" as const } };
      })();
    });
    const connection = {
      sessionUpdate: vi.fn(async () => undefined),
      extMethod: vi.fn(async () => ({})),
      extNotification: vi.fn(async () => undefined),
    } as unknown as AgentSideConnection;
    const adapter = new DurableSessionAgent({
      context,
      connection,
      diagnostics: { write: () => undefined },
      bindings: createMemorySubagentBindingStore(),
    });
    try {
      const fresh = await adapter.extMethod("deepseek/catalog", { cwd: project });
      const refreshed = await adapter.extMethod("deepseek/catalog", { cwd: project });
      expect(fetchSpy).not.toHaveBeenCalled();
      for (const catalog of [fresh, refreshed]) {
        expect(catalog).toMatchObject({
          defaultSelectionId: expect.any(String),
          providers: [
            expect.objectContaining({
              id: "deepseek-official",
              models: expect.arrayContaining([
                expect.objectContaining({
                  upstreamModelId: "deepseek-flash",
                  name: "DeepSeek-V41-Flash",
                  reasoningEfforts: ["off", "low", "high", "max"],
                  defaultReasoningEffort: "high",
                  supportsImages: true,
                }),
              ]),
            }),
          ],
        });
      }
      const created = await adapter.newSession({ cwd: project, mcpServers: [] });
      expect(created.configOptions?.[0]).toMatchObject({
        id: "deepseek.model",
        currentValue: (fresh.defaultSelectionId as string),
      });
      await expect(adapter.prompt({
        sessionId: created.sessionId,
        prompt: [{ type: "text", text: "synthetic prompt" }],
      })).resolves.toMatchObject({ stopReason: "end_turn" });
      expect(requests.find((request) => request.model === "deepseek-flash")).toEqual({
        provider: "deepseek-official",
        model: "deepseek-flash",
        reasoningEffort: "high",
      });
    } finally {
      stopStream();
      await adapter.dispose();
      await context.fiber.dispose();
      fetchSpy.mockRestore();
    }
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

  it("natively migrates released v0 seeded sessions without rewriting source bytes", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const project = join(root, "project");
    const childId = SessionId("released-v0-seeded-child");
    const parentId = SessionId("released-v0-parent");
    await mkdir(project);
    process.env.DSH_HOME = join(root, "home");
    delete process.env.DEEPSEEK_API_KEY;

    const legacyDir = join(stateDir, "sessions", projectStorageKey(project), String(childId));
    const legacyPath = join(legacyDir, "session.jsonl.zstd");
    await mkdir(legacyDir, { recursive: true });
    const legacyHeader = {
      type: "session",
      version: 0,
      id: String(childId),
      createdAt: 2,
      cwd: project,
      parentSession: String(parentId),
      seedLength: 6,
      delegationDepth: 0,
    };
    const legacyEvents = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      { type: "step/start", seq: 1, time: 11, data: { turn: 1, step: 1 } },
      {
        type: "request/header",
        seq: 2,
        time: 12,
        data: {
          header: {
            config: { provider: "deepseek-official", model: "deepseek-chat" },
            system: "Legacy system prompt",
          },
          reason: "initial",
        },
      },
      {
        type: "user/message",
        seq: 3,
        time: 13,
        surfaceOp: "append",
        data: {
          id: "legacy-user",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "inherited prompt" }],
        },
      },
      { type: "step/end", seq: 4, time: 14, data: { turn: 1, step: 1 } },
      { type: "turn/end", seq: 5, time: 15, data: { turn: 1, reason: { kind: "completed" } } },
      {
        type: "session/title",
        seq: 6,
        time: 20,
        data: { title: "Legacy seeded session", messageSeqs: [], source: { kind: "user" } },
      },
    ];
    const legacyBytes = Buffer.concat([
      zstdCompressSync(`${JSON.stringify(legacyHeader)}\n`, { params: { 201: 1 } }),
      zstdCompressSync(`${legacyEvents.map((event) => JSON.stringify(event)).join("\n")}\n`, { params: { 201: 1 } }),
    ]);
    await writeFile(legacyPath, legacyBytes);

    const context = await bootRuntime({ stateDir, workspaceRoot: project });
    try {
      const parent = await context.sessionPersistence.create({
        version: SESSION_FORMAT_VERSION,
        id: parentId,
        createdAt: 1,
        cwd: project,
        isSeeded: false,
      });
      await parent.flush();
      await parent.close();

      const query = context.get("sessionQuery") as unknown as {
        listSessions(): Promise<{ header: SessionHeader }[]>;
        observeSession(id: SessionId, options: { projectionMode: "none" }): Promise<{
          header: SessionHeader;
          inheritedEventCount: number;
          events: readonly SessionEvent[];
          [Symbol.dispose](): void;
        }>;
        traceSession(id: SessionId): Promise<unknown>;
      };
      const listed = await query.listSessions();
      expect(listed.map((record) => record.header.id)).toEqual([childId, parentId]);
      const childRecord = listed.find((record) => record.header.id === childId);
      expect(childRecord?.header).toMatchObject({ parentSession: parentId, isSeeded: true });

      const observation = await query.observeSession(childId, { projectionMode: "none" });
      try {
        expect(observation.header).toMatchObject({
          version: SESSION_FORMAT_VERSION,
          id: childId,
          parentSession: parentId,
          isSeeded: true,
        });
        expect(observation.inheritedEventCount).toBe(8);
        expect(observation.events.map((event) => event.type)).toContain("session/title");
      } finally {
        observation[Symbol.dispose]();
      }
      const lineage = await query.traceSession(childId);
      expect(lineage).toMatchObject({ complete: true, root: { header: { id: parentId } } });
      await expect(readFile(legacyPath)).resolves.toEqual(legacyBytes);

      const resumed = await context.agents.resume({ resumeSessionId: childId });
      await resumed.dispose();
      await expect(readFile(join(legacyDir, "session.v3.jsonl.zstd"))).resolves.not.toHaveLength(0);
      await expect(readFile(legacyPath)).resolves.toEqual(legacyBytes);
    } finally {
      await context.fiber.dispose();
    }
  });

  it("recovers and loads an interrupted JSONL session after restart", async () => {
    const root = await tempRoot();
    const stateDir = join(root, "state");
    const project = join(root, "project");
    await mkdir(project);
    process.env.DSH_HOME = join(root, "home");
    delete process.env.DEEPSEEK_API_KEY;
    const sessionId = SessionId("restart-session");
    const sessionEvents = [
      { type: "turn/start", seq: 0, time: 10, data: { turn: 1 } },
      { type: "step/start", seq: 1, time: 11, data: { turn: 1, step: 1 } },
      {
        type: "user/message",
        seq: 2,
        time: 12,
        surfaceOp: "append",
        data: {
          id: "restart-user",
          role: "user",
          source: { kind: "user" },
          content: [{ type: "text", text: "persisted question" }],
        },
      },
    ] as unknown as SessionEvent[];

    const first = await bootRuntime({ stateDir });
    const storage = await first.sessionPersistence.create({
      version: SESSION_FORMAT_VERSION,
      id: sessionId,
      createdAt: 1,
      cwd: project,
      isSeeded: false,
    });
    await storage.append(sessionEvents);
    await storage.flush();
    await storage.close();
    await first.fiber.dispose();

    const second = await bootRuntime({ stateDir });
    const updates: SessionNotification[] = [];
    const connection = {
      sessionUpdate: vi.fn(async (notification: SessionNotification) => {
        updates.push(notification);
      }),
      extMethod: vi.fn(async () => ({})),
    } as unknown as AgentSideConnection;
    const diagnostics: string[] = [];
    const agent = new DurableSessionAgent({
      context: second,
      connection,
      diagnostics: { write: (message) => diagnostics.push(message) },
      bindings: createMemorySubagentBindingStore(),
    });
    try {
      const listed = await agent.listSessions({});
      expect(listed.sessions).toEqual([
        expect.objectContaining({ sessionId: String(sessionId) }),
      ]);
      expect(listed.sessions[0]).not.toHaveProperty("title");

      const history = await agent.extMethod("deepseek/session/history", {
        sessionId: String(sessionId),
      });
      expect(history).toMatchObject({
        hasMore: false,
        updates: [
          {
            sessionId: String(sessionId),
            _meta: { "sesori.ai/deepseek": { messageCreatedAt: 12 } },
            update: {
              sessionUpdate: "user_message_chunk",
              messageId: "restart-user",
              content: { type: "text", text: "persisted question" },
            },
          },
        ],
      });
      expect(updates).toEqual([]);
      expect(second.agents.get(sessionId)).toBeUndefined();

      await expect(
        agent.loadSession({
          sessionId: String(sessionId),
          cwd: project,
          mcpServers: [],
        }),
      ).resolves.toMatchObject({
        configOptions: [
          { id: "deepseek.model", category: "model" },
          { id: "deepseek.reasoning_effort", category: "thought_level" },
        ],
      });
      expect(updates).toContainEqual({
        sessionId: String(sessionId),
        _meta: { "sesori.ai/deepseek": { messageCreatedAt: 12 } },
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "restart-user",
          content: { type: "text", text: "persisted question" },
        },
      });
      const questionTool = (second.get("tools") as {
        get(name: string): { execute(args: unknown, exec: unknown): Promise<unknown> } | undefined;
      }).get("ask_user_question");
      if (questionTool === undefined) throw new Error("ask_user_question was not registered");
      vi.mocked(connection.extMethod).mockResolvedValueOnce({
        answers: [{ questionId: "q1", selectedLabels: ["Yes"] }],
      });
      await expect(questionTool.execute(
        { questions: [{ id: "q1", question: "Proceed?", options: [{ label: "Yes" }] }] },
        { agent: second.agents.get(sessionId), signal: new AbortController().signal },
      )).resolves.toEqual({ answers: [{ id: "q1", selected: ["Yes"] }] });
      expect(connection.extMethod).toHaveBeenCalledWith(
        "deepseek/ask_user_question",
        expect.objectContaining({ sessionId: String(sessionId) }),
      );
      await agent.closeSession({ sessionId: String(sessionId) });
      expect((await second.sessionPersistence.list()).map((item) => item.header.id)).toContain(sessionId);
      expect(diagnostics).toEqual([]);
    } finally {
      await agent.dispose();
      await second.fiber.dispose();
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
