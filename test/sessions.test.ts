import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import { CommandId } from "@deepseek-ai/dsh-commands";
import { SessionId, type SessionEvent, type SessionHeader } from "@deepseek-ai/dsh-session";
import { describe, expect, it, vi } from "vitest";
import { DurableSessionAgent } from "../src/sessions.ts";

interface SessionServices {
  context: Context;
  headers: SessionHeader[];
  inspections: Map<string, { meta: SessionHeader; events: readonly SessionEvent[] }>;
  live: Map<string, AgentHandle>;
  create: ReturnType<typeof vi.fn>;
  resume: ReturnType<typeof vi.fn>;
  updates: SessionNotification[];
  diagnostics: string[];
  extNotifications: { method: string; params: Record<string, unknown> }[];
  requestPermission: ReturnType<typeof vi.fn>;
  extensionRequest: ReturnType<typeof vi.fn>;
  sessionUpdate: ReturnType<typeof vi.fn>;
  invoke(name: string, ...args: unknown[]): unknown;
  askQuestion(request: unknown): Promise<unknown>;
  contextServices: Map<string, unknown>;
  agent: DurableSessionAgent;
}

function header(args: { id: string; cwd: string; createdAt?: number }): SessionHeader {
  return {
    version: 0,
    id: SessionId(args.id),
    cwd: args.cwd,
    createdAt: args.createdAt ?? 1,
  };
}

function events(): SessionEvent[] {
  return [
    {
      type: "user/message",
      seq: 0,
      time: 10,
      surfaceOp: "append",
      data: {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "question" }],
      },
    },
    {
      type: "assistant/message",
      seq: 1,
      time: 20,
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant-1",
          role: "assistant",
          source: { kind: "model", provider: "synthetic", model: "synthetic" },
          content: [
            { type: "reasoning", text: "thought" },
            { type: "text", text: "answer" },
          ],
        },
      },
    },
  ] as unknown as SessionEvent[];
}

function services(): SessionServices {
  const headers: SessionHeader[] = [];
  const inspections = new Map<string, { meta: SessionHeader; events: readonly SessionEvent[] }>();
  const live = new Map<string, AgentHandle>();
  const listeners = new Map<string, ((...args: never[]) => unknown)[]>();
  const contextServices = new Map<string, unknown>();
  let context: Context;
  let questionProvider: { ask(request: unknown): Promise<unknown> } | undefined;
  const makeHandle = async (
    meta: SessionHeader,
    sessionEvents: readonly SessionEvent[],
    setup?: (context: Context) => void | Promise<void>,
  ): Promise<AgentHandle> => {
    const storedEvents = [...sessionEvents];
    const agent = {
      id: meta.id,
      session: {
        id: meta.id,
        header: meta,
        events: storedEvents,
        requestHeader: () => undefined,
        append: (type: string, data: unknown) => {
          const event = { type, seq: storedEvents.length, time: Date.now(), data } as unknown as SessionEvent;
          storedEvents.push(event);
          (context as unknown as { __emit(name: string, ...args: unknown[]): void }).__emit("session/event", agent.session, event);
          return event;
        },
      },
      status: "idle",
      followup: vi.fn((message: unknown) => {
        for (const listener of listeners.get("agent/inbox/claimed") ?? []) listener({ agent, message, turn: 1 } as never);
      }),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => undefined),
    };
    const agentContext = Object.assign(Object.create(context), { agent });
    Object.assign(agent, { ctx: agentContext });
    await setup?.(agentContext as Context);
    const handle = {
      agent,
      dispose: vi.fn(async () => {
        live.delete(String(meta.id));
      }),
    } as unknown as AgentHandle;
    live.set(String(meta.id), handle);
    return handle;
  };
  const create = vi.fn(async (options: { sessionId: string; meta: { cwd: string }; setup?: (context: Context) => void }) => {
    return makeHandle(header({ id: options.sessionId, cwd: options.meta.cwd }), [], options.setup);
  });
  const resume = vi.fn(async (options: { resumeSessionId: string; setup?: (context: Context) => void }) => {
    const inspection = inspections.get(options.resumeSessionId);
    if (inspection === undefined) throw new Error("not found");
    return makeHandle(inspection.meta, inspection.events, options.setup);
  });
  context = {
    on: (name: string, listener: (...args: never[]) => unknown) => {
      listeners.set(name, [...(listeners.get(name) ?? []), listener]);
      return () => undefined;
    },
    agents: {
      create,
      resume,
      get: (id: string) => live.get(id)?.agent,
    },
    sessions: { flush: vi.fn(async () => true) },
    llm: {
      listProviders: () => [],
      listModels: async () => [],
      resolveModelInfo: async () => {
        throw new Error("model unavailable");
      },
    },
    agentDefaultModel: { currentSelection: () => ({ provider: "synthetic", model: "synthetic" }) },
    commands: { list: () => [], find: () => undefined },
    sessionTitle: {
      rename: (session: { append(type: string, data: unknown): unknown }, title: string) => {
        session.append("session/title", { title, messageSeqs: [], source: { kind: "user" } });
        return { title, seq: 0, updatedAt: Date.now() };
      },
    },
    sessionPersistence: {
      list: vi.fn(async () => [...headers]),
      inspect: vi.fn(async (id: string) => {
        const inspection = inspections.get(id);
        if (inspection !== undefined) return inspection;
        const meta = headers.find((candidate) => candidate.id === id);
        if (meta === undefined) throw new Error("not found");
        return { meta, events: [] };
      }),
    },
    get: (name: string) => contextServices.get(name) ?? (context as unknown as Record<string, unknown>)[name],
    __emit: (name: string, ...args: unknown[]) => {
      for (const listener of listeners.get(name) ?? []) listener(...(args as never[]));
    },
  } as unknown as Context;
  contextServices.set("userQuestions", {
    registerProvider: (provider: { ask(request: unknown): Promise<unknown> }) => {
      questionProvider = provider;
      return () => {
        if (questionProvider === provider) questionProvider = undefined;
      };
    },
  });
  const updates: SessionNotification[] = [];
  const extNotifications: { method: string; params: Record<string, unknown> }[] = [];
  const requestPermission = vi.fn(async () => ({ outcome: { outcome: "cancelled" } }));
  const extensionRequest = vi.fn(async () => ({ answers: [] }));
  const sessionUpdate = vi.fn(async (notification: SessionNotification) => {
    updates.push(notification);
  });
  const connection = {
    sessionUpdate,
    requestPermission,
    extMethod: extensionRequest,
    extNotification: vi.fn(async (method: string, params: Record<string, unknown>) => {
      extNotifications.push({ method, params });
    }),
  } as unknown as AgentSideConnection;
  const diagnostics: string[] = [];
  const agent = new DurableSessionAgent({
    context,
    connection,
    diagnostics: { write: (message) => diagnostics.push(message) },
  });
  return {
    context,
    headers,
    inspections,
    live,
    create,
    resume,
    updates,
    diagnostics,
    extNotifications,
    requestPermission,
    extensionRequest,
    sessionUpdate,
    invoke: (name, ...args) => listeners.get(name)?.at(-1)?.(...(args as never[])),
    askQuestion: (request) => {
      if (questionProvider === undefined) throw new Error("question provider is unavailable");
      return questionProvider.ask(request);
    },
    contextServices,
    agent,
  };
}

describe("durable ACP sessions", () => {
  it("creates two independently owned sessions and closes without deleting persistence", async () => {
    const state = services();
    const first = await state.agent.newSession({ cwd: "/project-a", mcpServers: [] });
    const second = await state.agent.newSession({ cwd: "/project-b", mcpServers: [] });

    expect(first.sessionId).not.toBe(second.sessionId);
    expect(state.live.size).toBe(2);
    expect((await state.agent.listSessions({})).sessions).toEqual([]);

    await state.agent.closeSession({ sessionId: first.sessionId });
    await state.agent.closeSession({ sessionId: first.sessionId });
    expect(state.live.has(first.sessionId)).toBe(false);
    expect(state.live.has(second.sessionId)).toBe(true);
    expect(state.headers).toEqual([]);
    await state.agent.dispose();
    expect(state.live.size).toBe(0);
  });

  it("retains ownership when close disposal fails so the caller can retry", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId);
    if (handle === undefined) throw new Error("test handle was not created");
    vi.mocked(handle.dispose).mockRejectedValueOnce(new Error("synthetic disposal failure"));

    await expect(state.agent.closeSession({ sessionId: created.sessionId })).rejects.toThrow(
      "unable to close DeepSeek session",
    );
    await expect(state.agent.closeSession({ sessionId: created.sessionId })).resolves.toEqual({});
    expect(handle.dispose).toHaveBeenCalledTimes(2);
    expect(state.live.has(created.sessionId)).toBe(false);
  });

  it("rejects close after owner disposal", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId);
    if (handle === undefined) throw new Error("test handle was not created");

    await state.agent.dispose();

    expect(() => state.agent.closeSession({ sessionId: created.sessionId })).toThrow(
      "the ACP session owner has been disposed",
    );
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("rejects unsupported setup before creating an agent", async () => {
    const state = services();

    await expect(state.agent.newSession({ cwd: "relative", mcpServers: [] })).rejects.toThrow(
      "cwd must be an absolute bounded path",
    );
    await expect(
      state.agent.newSession({ cwd: "/project", mcpServers: [{} as never] }),
    ).rejects.toThrow("MCP servers are not supported");
    await expect(
      state.agent.newSession({
        cwd: "/project",
        mcpServers: [],
        additionalDirectories: ["/other"],
      }),
    ).rejects.toThrow("additional directories are not supported");
    expect(state.create).not.toHaveBeenCalled();
  });

  it("makes owner disposal wait for pending session creation cleanup", async () => {
    const state = services();
    const createStarted = Promise.withResolvers<void>();
    const releaseCreate = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {
      throw new Error("synthetic creation cleanup failure");
    });
    state.create.mockImplementationOnce(async (options: { sessionId: string; meta: { cwd: string } }) => {
      createStarted.resolve();
      await releaseCreate.promise;
      return {
        agent: { session: { id: SessionId(options.sessionId) } },
        dispose,
      } as unknown as AgentHandle;
    });

    const creating = state.agent.newSession({ cwd: "/project", mcpServers: [] });
    await createStarted.promise;
    let disposalCompleted = false;
    const ownerDisposal = state.agent.dispose().then(() => {
      disposalCompleted = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(disposalCompleted).toBe(false);

    releaseCreate.resolve();
    await expect(creating).rejects.toThrow("unable to create DeepSeek session");
    await expect(ownerDisposal).rejects.toThrow("synthetic creation cleanup failure");
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("lists cold materialized sessions without resuming them", async () => {
    const state = services();
    state.headers.push(
      header({ id: "older", cwd: "/project-a", createdAt: 10 }),
      header({ id: "newer", cwd: "/project-b", createdAt: 20 }),
    );

    const listed = await state.agent.listSessions({});
    expect(listed.sessions.map((session) => session.sessionId)).toEqual(["newer", "older"]);
    expect(listed.sessions[0]?._meta).toEqual({
      "sesori.ai/deepseek": { createdAt: 20 },
    });
    expect(state.resume).not.toHaveBeenCalled();
    await expect(state.agent.listSessions({ cwd: "relative" })).rejects.toThrow(
      "cwd filter must be an absolute bounded path",
    );
  });

  it("lists only bounded headers and accepts omitted persisted titles", async () => {
    const state = services();
    for (let index = 0; index < 101; index += 1) {
      const meta = header({ id: `titled-${String(index).padStart(3, "0")}`, cwd: "/project", createdAt: index });
      state.headers.push(meta);
      state.inspections.set(String(meta.id), {
        meta,
        events: [{
          type: "session/title",
          seq: 0,
          time: index + 1_000,
          data: { title: `Title ${index}`, messageSeqs: [], source: { kind: "user" } },
        }] as SessionEvent[],
      });
    }

    const listed = await state.agent.listSessions({});

    expect(listed.sessions).toHaveLength(100);
    expect(listed.sessions[0]).not.toHaveProperty("title");
    expect(state.context.sessionPersistence.inspect).not.toHaveBeenCalled();
    expect(state.resume).not.toHaveBeenCalled();
  });

  it("paginates session headers with an opaque stable cursor", async () => {
    const state = services();
    for (let index = 0; index < 101; index += 1) {
      state.headers.push(
        header({ id: `session-${String(index).padStart(3, "0")}`, cwd: "/project", createdAt: 1 }),
      );
    }

    const first = await state.agent.listSessions({});
    expect(first.sessions).toHaveLength(100);
    expect(first.nextCursor).toEqual(expect.any(String));
    const second = await state.agent.listSessions({ cursor: first.nextCursor as string });
    expect(second.sessions.map((session) => session.sessionId)).toEqual(["session-100"]);
    await expect(state.agent.listSessions({ cursor: "not-a-cursor" })).rejects.toThrow(
      "invalid session list cursor",
    );
  });

  it("paginates canonically equivalent but distinct Unicode session ids", async () => {
    const state = services();
    for (let index = 0; index < 99; index += 1) {
      state.headers.push(
        header({ id: `a-${String(index).padStart(3, "0")}`, cwd: "/project", createdAt: 1 }),
      );
    }
    state.headers.push(
      header({ id: "\u00e9", cwd: "/project", createdAt: 1 }),
      header({ id: "e\u0301", cwd: "/project", createdAt: 1 }),
    );

    const first = await state.agent.listSessions({});
    const second = await state.agent.listSessions({ cursor: first.nextCursor as string });
    const ids = [...first.sessions, ...second.sessions].map((session) => session.sessionId);

    expect(ids).toHaveLength(101);
    expect(new Set(ids).size).toBe(101);
  });

  it("fails loudly when persistence reports duplicate session identities", async () => {
    const state = services();
    state.headers.push(
      header({ id: "duplicate", cwd: "/project" }),
      header({ id: "duplicate", cwd: "/project" }),
    );

    await expect(state.agent.listSessions({})).rejects.toThrow("unable to list DeepSeek sessions");
    expect(state.diagnostics.join("\n")).toContain("duplicate persisted session id");
  });

  it("resumes a cold session and replays stable message identities before returning", async () => {
    const state = services();
    const meta = header({ id: "cold", cwd: "/project" });
    const sessionEvents = events();
    state.headers.push(meta);
    state.inspections.set("cold", { meta, events: sessionEvents });

    await expect(
      state.agent.loadSession({
        sessionId: "cold",
        cwd: "/project",
        mcpServers: [],
      }),
    ).resolves.toEqual({ configOptions: [] });

    expect(state.resume).toHaveBeenCalledOnce();
    const projectedAssistantId = (state.updates[1]?.update as { messageId?: string } | undefined)?.messageId;
    expect(projectedAssistantId).toEqual(expect.stringMatching(/^deepseek-assistant-/));
    expect(state.updates).toEqual([
      {
        sessionId: "cold",
        update: {
          sessionUpdate: "user_message_chunk",
          messageId: "user-1",
          content: { type: "text", text: "question" },
        },
      },
      {
        sessionId: "cold",
        update: {
          sessionUpdate: "agent_thought_chunk",
          messageId: projectedAssistantId,
          content: { type: "text", text: "thought" },
        },
      },
      {
        sessionId: "cold",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: projectedAssistantId,
          content: { type: "text", text: "answer" },
        },
      },
      {
        sessionId: "cold",
        update: { sessionUpdate: "available_commands_update", availableCommands: [] },
      },
    ]);

    await state.agent.loadSession({ sessionId: "cold", cwd: "/project", mcpServers: [] });
    expect(state.resume).toHaveBeenCalledOnce();
  });

  it("rejects resident replay while a prompt is active", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const prompt = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);

    await expect(
      state.agent.loadSession({ sessionId: created.sessionId, cwd: "/project", mcpServers: [] }),
    ).rejects.toThrow("cannot load a session while its prompt is active");

    await state.agent.cancel({ sessionId: created.sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("rejects prompt admission while resident replay is active", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const residentEvents = handle.agent.session.events as SessionEvent[];
    residentEvents.push({
      type: "user/message",
      seq: 0,
      time: 1,
      surfaceOp: "append",
      data: {
        id: "user-1",
        role: "user",
        source: { kind: "user" },
        content: [{ type: "text", text: "question" }],
      },
    } as SessionEvent);
    const replayOutput = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(async (notification: SessionNotification) => {
      state.updates.push(notification);
      await replayOutput.promise;
    });
    const loading = state.agent.loadSession({
      sessionId: created.sessionId,
      cwd: "/project",
      mcpServers: [],
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);

    await expect(
      state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "too soon" }] }),
    ).rejects.toThrow("session load is in progress");

    replayOutput.resolve();
    await loading;
  });

  it("disposes a resumed handle when shutdown wins the load race", async () => {
    const state = services();
    const meta = header({ id: "raced", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("raced", { meta, events: [] });
    const resumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {
      state.live.delete("raced");
    });
    const handle = {
      agent: { session: { id: meta.id, header: meta, events: [] } },
      dispose,
    } as unknown as AgentHandle;
    state.resume.mockImplementationOnce(async (options) => {
      resumed.resolve();
      await release.promise;
      await options.setup?.(Object.assign(Object.create(state.context), { agent: handle.agent }));
      state.live.set("raced", handle);
      return handle;
    });

    const loading = state.agent.loadSession({
      sessionId: "raced",
      cwd: "/project",
      mcpServers: [],
    });
    await resumed.promise;
    let disposalCompleted = false;
    const disposal = state.agent.dispose().then(() => {
      disposalCompleted = true;
    });
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(disposalCompleted).toBe(false);
    release.resolve();

    await expect(loading).rejects.toThrow("unable to load DeepSeek session");
    await disposal;
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.live.has("raced")).toBe(false);
  });

  it("cleans up when owner disposal wins during loaded config discovery", async () => {
    const state = services();
    const meta = header({ id: "load-config-race", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("load-config-race", { meta, events: [] });
    const lookup = Promise.withResolvers<unknown>();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "provider", name: "Provider" }],
      listModels: () => lookup.promise,
      resolveModelInfo: async () => ({}),
    });

    const loading = state.agent.loadSession({ sessionId: "load-config-race", cwd: "/project", mcpServers: [] });
    await expect.poll(() => state.resume.mock.calls.length).toBe(1);
    const disposal = state.agent.dispose();
    lookup.resolve([{ id: "model", name: "Model" }]);

    await expect(loading).rejects.toThrow("unable to load DeepSeek session");
    await disposal;
    expect(state.live.has("load-config-race")).toBe(false);
  });

  it("reports failed resumed-handle cleanup through owner disposal", async () => {
    const state = services();
    const meta = header({ id: "failed-cleanup", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("failed-cleanup", { meta, events: [] });
    const resumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {
      throw new Error("synthetic load cleanup failure");
    });
    const handle = {
      agent: { session: { id: meta.id, header: meta, events: [] } },
      dispose,
    } as unknown as AgentHandle;
    state.resume.mockImplementationOnce(async (options) => {
      resumed.resolve();
      await release.promise;
      await options.setup?.(Object.assign(Object.create(state.context), { agent: handle.agent }));
      state.live.set("failed-cleanup", handle);
      return handle;
    });

    const loading = state.agent.loadSession({
      sessionId: "failed-cleanup",
      cwd: "/project",
      mcpServers: [],
    });
    await resumed.promise;
    const ownerDisposal = state.agent.dispose();
    release.resolve();

    await expect(loading).rejects.toThrow("unable to load DeepSeek session");
    await expect(ownerDisposal).rejects.toThrow("synthetic load cleanup failure");
    expect(state.diagnostics.join("\n")).toContain("synthetic load cleanup failure");
  });

  it("degrades command enumeration failure while loading", async () => {
    const state = services();
    const meta = header({ id: "load-cleanup", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("load-cleanup", { meta, events: [] });
    state.contextServices.set("commands", {
      list: () => {
        throw new Error("synthetic command failure");
      },
    });
    const originalResume = state.resume.getMockImplementation() as (...args: unknown[]) => Promise<AgentHandle>;
    state.resume.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalResume(...args);
      vi.mocked(handle.dispose).mockRejectedValueOnce(new Error("synthetic load cleanup failure"));
      return handle;
    });

    await expect(
      state.agent.loadSession({ sessionId: "load-cleanup", cwd: "/project", mcpServers: [] }),
    ).resolves.toEqual({ configOptions: [] });
    expect(state.live.has("load-cleanup")).toBe(true);
    expect(state.diagnostics.join("\n")).toContain("commands/list category=unavailable");
    expect(state.diagnostics.join("\n")).not.toContain("synthetic command failure");
  });

  it("makes close wait for an in-flight load ownership transition", async () => {
    const state = services();
    const meta = header({ id: "closing-load", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("closing-load", { meta, events: [] });
    const resumed = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const dispose = vi.fn(async () => {
      state.live.delete("closing-load");
    });
    const handle = {
      agent: { session: { id: meta.id, header: meta, events: [] } },
      dispose,
    } as unknown as AgentHandle;
    state.resume.mockImplementationOnce(async (options) => {
      resumed.resolve();
      await release.promise;
      await options.setup?.(Object.assign(Object.create(state.context), { agent: handle.agent }));
      state.live.set("closing-load", handle);
      return handle;
    });

    const loading = state.agent.loadSession({
      sessionId: "closing-load",
      cwd: "/project",
      mcpServers: [],
    });
    await resumed.promise;
    let closeCompleted = false;
    const closing = state.agent.closeSession({ sessionId: "closing-load" }).then(() => {
      closeCompleted = true;
    });
    await Promise.resolve();
    expect(closeCompleted).toBe(false);

    release.resolve();
    await loading;
    await closing;
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.live.has("closing-load")).toBe(false);
  });

  it("shares an in-flight close transition between concurrent callers", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId);
    if (handle === undefined) throw new Error("test handle was not created");
    const disposeStarted = Promise.withResolvers<void>();
    const releaseDispose = Promise.withResolvers<void>();
    vi.mocked(handle.dispose).mockImplementationOnce(async () => {
      disposeStarted.resolve();
      await releaseDispose.promise;
      state.live.delete(created.sessionId);
    });

    const first = state.agent.closeSession({ sessionId: created.sessionId });
    await disposeStarted.promise;
    let secondCompleted = false;
    const second = state.agent.closeSession({ sessionId: created.sessionId }).then(() => {
      secondCompleted = true;
    });
    await Promise.resolve();
    expect(secondCompleted).toBe(false);

    releaseDispose.resolve();
    await Promise.all([first, second]);
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("reports an in-flight close failure through owner disposal", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId);
    if (handle === undefined) throw new Error("test handle was not created");
    const disposeStarted = Promise.withResolvers<void>();
    const releaseDispose = Promise.withResolvers<void>();
    vi.mocked(handle.dispose).mockImplementationOnce(async () => {
      disposeStarted.resolve();
      await releaseDispose.promise;
      throw new Error("synthetic close failure");
    });

    const closing = state.agent.closeSession({ sessionId: created.sessionId });
    await disposeStarted.promise;
    const ownerDisposal = state.agent.dispose();
    releaseDispose.resolve();

    await expect(closing).rejects.toThrow("unable to close DeepSeek session");
    await expect(ownerDisposal).rejects.toThrow("unable to close DeepSeek session");
    expect(state.diagnostics.join("\n")).toContain("synthetic close failure");
  });

  it("makes load wait for an in-flight close transition", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId);
    if (handle === undefined) throw new Error("test handle was not created");
    const meta = header({ id: created.sessionId, cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set(created.sessionId, { meta, events: [] });
    const disposeStarted = Promise.withResolvers<void>();
    const releaseDispose = Promise.withResolvers<void>();
    vi.mocked(handle.dispose).mockImplementationOnce(async () => {
      disposeStarted.resolve();
      await releaseDispose.promise;
      state.live.delete(created.sessionId);
    });

    const closing = state.agent.closeSession({ sessionId: created.sessionId });
    await disposeStarted.promise;
    const loading = state.agent.loadSession({
      sessionId: created.sessionId,
      cwd: "/project",
      mcpServers: [],
    });
    let loadSettled = false;
    void loading.then(
      () => {
        loadSettled = true;
      },
      () => {
        loadSettled = true;
      },
    );
    await new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
    expect(loadSettled).toBe(false);

    releaseDispose.resolve();
    await closing;
    await expect(loading).resolves.toEqual({ configOptions: [] });
    expect(state.resume).toHaveBeenCalledOnce();
  });

  it("diagnoses cleanup failure when a newly created handle cannot be adopted", async () => {
    const state = services();
    const dispose = vi.fn(async () => {
      throw new Error("synthetic cleanup failure");
    });
    state.create.mockResolvedValueOnce({
      agent: { session: { id: SessionId("mismatched") } },
      dispose,
    } as unknown as AgentHandle);

    await expect(state.agent.newSession({ cwd: "/project", mcpServers: [] })).rejects.toThrow(
      "unable to create DeepSeek session",
    );
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.diagnostics.join("\n")).toContain("session/new cleanup");
    expect(state.diagnostics.join("\n")).toContain("synthetic cleanup failure");
  });

  it("removes a failed new session record after cleaning up its handle", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => {
        throw new Error("synthetic catalog failure");
      },
    });

    await expect(state.agent.newSession({ cwd: "/project", mcpServers: [] })).rejects.toThrow(
      "unable to create DeepSeek session",
    );
    const sessionId = state.create.mock.calls[0]![0].sessionId as string;
    const handle = await state.create.mock.results[0]!.value as AgentHandle;
    expect(state.live.has(sessionId)).toBe(false);

    await expect(state.agent.closeSession({ sessionId })).resolves.toEqual({});
    expect(handle.dispose).toHaveBeenCalledOnce();
  });

  it("cleans up when owner disposal wins after new-session output", async () => {
    const state = services();
    const output = Promise.withResolvers<void>();
    state.contextServices.set("commands", {
      list: () => [{ name: "compact", description: "Compact" }],
    });
    state.sessionUpdate.mockReturnValueOnce(output.promise);
    const creating = state.agent.newSession({ cwd: "/project", mcpServers: [] });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);

    const disposal = state.agent.dispose();
    output.resolve();

    await expect(creating).rejects.toThrow("unable to create DeepSeek session");
    await disposal;
    expect(state.live.size).toBe(0);
  });

  it("retains an adopted new session when failure cleanup disposal fails", async () => {
    const state = services();
    state.contextServices.set("commands", {
      list: () => [{ name: "compact", description: "Compact" }],
    });
    const commandUpdate = Promise.withResolvers<void>();
    state.sessionUpdate.mockReturnValueOnce(commandUpdate.promise);
    const creating = state.agent.newSession({ cwd: "/project", mcpServers: [] });
    await expect.poll(() => state.live.size).toBe(1);
    const [sessionId, handle] = [...state.live.entries()][0]!;
    vi.mocked(handle.dispose).mockRejectedValueOnce(new Error("synthetic cleanup failure"));
    commandUpdate.reject(new Error("synthetic command update failure"));

    await expect(creating).rejects.toThrow("unable to create DeepSeek session");
    await expect(state.agent.closeSession({ sessionId })).resolves.toEqual({});
    expect(handle.dispose).toHaveBeenCalledTimes(2);
  });

  it("rejects control characters in session ids before diagnostics", async () => {
    const state = services();

    for (const sessionId of ["forged\nlog", "forged\u0085log"]) {
      await expect(
        state.agent.loadSession({ sessionId, cwd: "/project", mcpServers: [] }),
      ).rejects.toThrow("invalid session id");
    }
    expect(state.diagnostics).toEqual([]);
  });

  it("reads paginated detached history without creating or resuming an agent", async () => {
    const state = services();
    const meta = header({ id: "history", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("history", { meta, events: events() });

    const page = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "history",
      maxMessages: 1,
    });
    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSeq).toBe(1);
    expect(page.updates).toHaveLength(2);
    expect(state.create).not.toHaveBeenCalled();
    expect(state.resume).not.toHaveBeenCalled();

    const previous = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "history",
      beforeSeq: 1,
      maxMessages: 1,
    });
    expect(previous).toMatchObject({ hasMore: false });
    expect(previous.updates).toHaveLength(1);
  });

  it("counts command results as history message boundaries", async () => {
    const state = services();
    const meta = header({ id: "command-history", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("command-history", {
      meta,
      events: [
        ...events(),
        {
          type: "command/done",
          seq: 2,
          time: 30,
          data: { commandId: CommandId("command-1"), kind: "success", text: "Compacted" },
        } as SessionEvent,
      ],
    });

    const page = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "command-history",
      maxMessages: 1,
    });

    expect(page.hasMore).toBe(true);
    expect(page.nextBeforeSeq).toBe(2);
    expect(page.updates).toEqual([
      expect.objectContaining({ update: expect.objectContaining({ content: { type: "text", text: "Compacted" } }) }),
    ]);
  });

  it("rejects cwd conflicts and unknown required history events", async () => {
    const state = services();
    const meta = header({ id: "conflict", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("conflict", {
      meta,
      events: [
        {
          type: "future/required",
          seq: 0,
          time: 1,
          data: {},
        } as unknown as SessionEvent,
      ],
    });

    await expect(
      state.agent.loadSession({ sessionId: "conflict", cwd: "/wrong", mcpServers: [] }),
    ).rejects.toThrow("cwd does not match persisted session");
    await expect(
      state.agent.extMethod("deepseek/session/history", { sessionId: "conflict" }),
    ).rejects.toThrow("unable to read DeepSeek session history");
    await expect(
      state.agent.loadSession({ sessionId: "conflict", cwd: "/project", mcpServers: [] }),
    ).rejects.toThrow("unable to load DeepSeek session");
    expect(state.resume).not.toHaveBeenCalled();
    expect(state.diagnostics.join("\n")).toContain("unsupported required event");
  });

  it("skips unknown history events only when the writer marked them ignorable", async () => {
    const state = services();
    const meta = header({ id: "future", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("future", {
      meta,
      events: [
        ...events(),
        {
          type: "future/informational",
          seq: 2,
          time: 30,
          data: {},
          ignorable: true,
        } as unknown as SessionEvent,
      ],
    });

    const response = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "future",
    });
    expect(response.updates).toHaveLength(3);
  });

  it("streams token output before turn completion and replays the same deterministic assistant id", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const completion = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
      _meta: { "sesori.ai/deepseek": { messageId: "caller-message-1" } },
    });
    const emitted = (state.context as unknown as { __emit(name: string, ...args: unknown[]): void }).__emit;
    emitted("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: { turn: 1, step: 2, chunk: { type: "text-delta", index: 0, text: "live" } },
    });
    await expect.poll(() => state.updates.length).toBe(1);
    const liveId = (state.updates[0]!.update as { messageId?: string }).messageId;
    expect(liveId).toEqual(expect.stringMatching(/^deepseek-assistant-/));
    emitted("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
    await expect(completion).resolves.toEqual({ stopReason: "end_turn" });
    expect(vi.mocked(handle.agent.followup)).toHaveBeenCalledWith(
      expect.objectContaining({ id: "caller-message-1" }),
    );

    const replayState = services();
    const meta = header({ id: created.sessionId, cwd: "/project" });
    replayState.headers.push(meta);
    replayState.inspections.set(created.sessionId, {
      meta,
      events: [{
        type: "assistant/message",
        seq: 1,
        time: 1,
        surfaceOp: "append",
        data: {
          turn: 1,
          step: 2,
          message: {
            id: "upstream-random-id",
            role: "assistant",
            source: { kind: "model", provider: "synthetic", model: "synthetic" },
            content: [{ type: "text", text: "live" }],
          },
        },
      }] as unknown as SessionEvent[],
    });
    const replay = await replayState.agent.extMethod("deepseek/session/history", { sessionId: created.sessionId });
    expect(((replay.updates as SessionNotification[])[0]?.update as { messageId?: string } | undefined)?.messageId).toBe(liveId);
  });

  it("returns max-token settlement with exact turn usage", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const completion = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);

    state.invoke("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: {
        turn: 1,
        step: 1,
        chunk: {
          type: "usage",
          usage: {
            inputTokens: 10,
            outputTokens: 4,
            cacheReadTokens: 2,
            reasoningTokens: 1,
          },
        },
      },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "max-tokens" } },
    });

    await expect(completion).resolves.toEqual({
      stopReason: "max_tokens",
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        cachedReadTokens: 2,
        thoughtTokens: 1,
        totalTokens: 16,
      },
    });
  });

  it("exposes opaque catalogs and applies exact model and reasoning selections", async () => {
    const state = services();
    const secret = "SENTINEL_PROVIDER_CREDENTIAL";
    state.contextServices.set("llm", {
      listProviders: () => [
        { id: "gateway/東京", name: "Gateway 東京" },
        { id: "broken\ninjected", name: "Broken" },
      ],
      listModels: async (provider: string) => {
        if (provider === "broken\ninjected") throw new Error(secret);
        return [
          { provider, id: "models/code/pro", name: "Code / Pro" },
          { provider, id: "模型/vision", name: "Vision 模型" },
        ];
      },
      resolveModelInfo: async (provider: string, model: string) => ({
        provider,
        id: model,
        name: model,
        inputModalities: model.includes("vision") ? ["text", "image"] : ["text"],
        reasoning: {
          efforts: [
            { id: "low", name: "Low" },
            { id: "high", name: "High" },
          ],
          defaultEffort: "high",
        },
      }),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "gateway/東京", model: "models/code/pro", reasoningEffort: "low" }),
    });
    state.contextServices.set("commands", {
      list: () => [{ name: "compact", description: "Compact context" }],
      find: () => undefined,
    });

    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });
    const providers = catalog.providers as { id: string; models: { id: string; upstreamModelId: string; supportsImages: boolean }[] }[];
    expect(providers).toHaveLength(1);
    expect(providers[0]?.models.map((model) => model.upstreamModelId)).toEqual([
      "models/code/pro",
      "模型/vision",
    ]);
    expect(providers[0]?.models.every((model) => model.id.startsWith("v1") && !model.id.includes("/"))).toBe(true);
    expect(providers[0]?.models[1]?.supportsImages).toBe(true);
    expect(catalog.failures).toEqual([
      { providerId: "broken\ninjected", category: "unavailable", message: "Provider catalog unavailable" },
    ]);
    expect(JSON.stringify(catalog)).not.toContain(secret);
    expect(state.diagnostics).toContain(
      "sesori-deepseek-acp: deepseek/catalog provider provider=\"broken\\ninjected\" category=unavailable\n",
    );
    expect(state.diagnostics.join("\n")).not.toContain(secret);

    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    expect(created.configOptions?.map((option) => option.id)).toEqual([
      "deepseek.model",
      "deepseek.reasoning_effort",
    ]);
    const nextModel = providers[0]!.models[1]!.id;
    const selected = await state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: nextModel,
    });
    expect(selected.configOptions[0]?.currentValue).toBe(nextModel);
    const reasoning = await state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.reasoning_effort",
      value: "low",
    });
    expect(reasoning.configOptions[1]?.currentValue).toBe("low");
    await expect(
      state.agent.setSessionConfigOption!({
        sessionId: created.sessionId,
        configId: "deepseek.reasoning_effort",
        value: "invented",
      }),
    ).rejects.toThrow("unknown DeepSeek reasoning effort");
  });

  it("sanitizes provider enumeration failures", async () => {
    const state = services();
    const secret = "SENTINEL_PROVIDER_ENUMERATION";
    state.contextServices.set("llm", {
      listProviders: () => {
        throw new Error(secret);
      },
    });

    await expect(state.agent.extMethod("deepseek/catalog", { cwd: "/project" })).rejects.toThrow();

    expect(state.diagnostics.join("\n")).toContain("deepseek/catalog providers category=unavailable");
    expect(state.diagnostics.join("\n")).not.toContain(secret);
  });

  it("classifies a provider with more than 256 models as unavailable", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [
        { id: "oversized", name: "Oversized" },
        { id: "working", name: "Working" },
      ],
      listModels: async (provider: string) => provider === "oversized"
        ? Array.from({ length: 257 }, (_, index) => ({ id: `model-${index}`, name: `Model ${index}` }))
        : [{ id: "model", name: "Model" }],
      resolveModelInfo: async () => ({}),
    });

    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });

    expect(catalog.providers).toEqual([expect.objectContaining({ id: "working" })]);
    expect(catalog.failures).toEqual([
      { providerId: "oversized", category: "unavailable", message: "Provider catalog unavailable" },
    ]);
  });

  it("classifies nested provider schema violations independently", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "broken", name: "Broken" }, { id: "working", name: "Working" }],
      listModels: async () => [{ id: "model", name: "Model" }],
      resolveModelInfo: async (provider: string) => provider === "broken"
        ? { reasoning: { efforts: [{ id: "low" }, { id: "low" }], defaultEffort: "low" } }
        : {},
    });

    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });

    expect(catalog.providers).toEqual([expect.objectContaining({ id: "working" })]);
    expect(catalog.failures).toEqual([
      { providerId: "broken", category: "unavailable", message: "Provider catalog unavailable" },
    ]);
  });

  it("classifies a provider with oversized generated selection ids as unavailable", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [
        { id: "oversized", name: "Oversized" },
        { id: "working", name: "Working" },
      ],
      listModels: async (provider: string) => [{ id: provider === "oversized" ? "x".repeat(512) : "model", name: "Model" }],
      resolveModelInfo: async () => ({}),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "working", model: "model" }),
    });

    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });

    expect(catalog.providers).toEqual([expect.objectContaining({ id: "working" })]);
    expect(catalog.failures).toEqual([
      { providerId: "oversized", category: "unavailable", message: "Provider catalog unavailable" },
    ]);
  });

  it("degrades config options when current selection exceeds opaque bounds", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [
        { id: "oversized", name: "Oversized" },
        { id: "working", name: "Working" },
      ],
      listModels: async (provider: string) => [{ id: provider === "oversized" ? "x".repeat(512) : "model", name: "Model" }],
      resolveModelInfo: async () => ({}),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "oversized", model: "x".repeat(512) }),
    });

    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const loaded = await state.agent.loadSession({ sessionId: created.sessionId, cwd: "/project", mcpServers: [] });

    expect(created.configOptions).toEqual([]);
    expect(loaded.configOptions).toEqual([]);
    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });
    expect(catalog).toMatchObject({
      defaultSelectionId: null,
      providers: [expect.objectContaining({ id: "working" })],
      failures: [{ providerId: "oversized", category: "unavailable", message: "Provider catalog unavailable" }],
    });
  });

  it("rejects oversized opaque model selections before decoding", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const oversized = `v1${"A".repeat(511)}`;
    const from = vi.spyOn(Buffer, "from");

    await expect(
      state.agent.setSessionConfigOption!({
        sessionId: created.sessionId,
        configId: "deepseek.model",
        value: oversized,
      }),
    ).rejects.toThrow("unknown DeepSeek model selection");

    expect(from.mock.calls.some(([value]) => value === oversized.slice(2))).toBe(false);
    from.mockRestore();
  });

  it("keeps config options usable when selected model is absent from a partial catalog", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "surviving", name: "Surviving" }],
      listModels: async () => [{ id: "available", name: "Available" }],
      resolveModelInfo: async () => ({ reasoning: { efforts: [{ id: "low" }], defaultEffort: "low" } }),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "missing", model: "selected", reasoningEffort: "high" }),
    });

    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });

    expect(created.configOptions).toEqual([
      expect.objectContaining({ id: "deepseek.model", currentValue: expect.any(String) }),
    ]);
  });

  it("reuses the fetched catalog when returning a changed config selection", async () => {
    const state = services();
    const listProviders = vi.fn(() => [{ id: "provider", name: "Provider" }]);
    state.contextServices.set("llm", {
      listProviders,
      listModels: async () => [{ id: "first", name: "First" }, { id: "second", name: "Second" }],
      resolveModelInfo: async () => ({}),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "provider", model: "first" }),
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });
    const nextModel = (catalog.providers as { models: { id: string }[] }[])[0]!.models[1]!.id;
    listProviders.mockClear();

    await state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: nextModel,
    });

    expect(listProviders).toHaveBeenCalledOnce();
  });

  it("rejects config mutation while a prompt is in flight before and after catalog lookup", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const execution = Promise.withResolvers<unknown>();
    state.contextServices.set("commands", {
      list: () => [{ name: "hold", description: "Hold" }],
      find: () => ({}),
      execute: () => execution.promise,
    });
    const prompting = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "/hold" }],
    });
    await Promise.resolve();

    await expect(state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: "unknown",
    })).rejects.toThrow("a prompt is in flight for this session");

    execution.resolve({});
    state.invoke("command/done", state.live.get(created.sessionId)!.agent, { kind: "completed" });
    await prompting;

    const lookup = Promise.withResolvers<unknown>();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "provider", name: "Provider" }],
      listModels: () => lookup.promise,
      resolveModelInfo: async () => ({}),
    });
    const changing = state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: "unknown",
    });
    await Promise.resolve();
    const secondExecution = Promise.withResolvers<unknown>();
    state.contextServices.set("commands", {
      list: () => [{ name: "hold", description: "Hold" }],
      find: () => ({}),
      execute: () => secondExecution.promise,
    });
    const secondPrompt = state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/hold" }] });
    await Promise.resolve();
    lookup.resolve([]);

    await expect(changing).rejects.toThrow("a prompt is in flight for this session");
    secondExecution.resolve({});
    state.invoke("command/done", state.live.get(created.sessionId)!.agent, { kind: "completed" });
    await secondPrompt;
  });

  it("rejects config mutation while session load starts during catalog lookup", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const lookup = Promise.withResolvers<unknown>();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "provider", name: "Provider" }],
      listModels: () => lookup.promise,
      resolveModelInfo: async () => ({}),
    });
    const changing = state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: "unknown",
    });
    await Promise.resolve();
    const inspection = Promise.withResolvers<{ meta: SessionHeader; events: readonly SessionEvent[] }>();
    vi.mocked(state.context.sessionPersistence.inspect).mockReturnValueOnce(inspection.promise);
    const loading = state.agent.loadSession({ sessionId: created.sessionId, cwd: "/project", mcpServers: [] });
    lookup.resolve([]);

    await expect(changing).rejects.toThrow("session load is in progress");
    inspection.resolve({ meta: header({ id: created.sessionId, cwd: "/project" }), events: [] });
    await loading;
  });

  it("rejects config mutation when ownership changes during catalog lookup", async () => {
    const state = services();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "provider", name: "Provider" }],
      listModels: async () => [{ id: "first", name: "First" }, { id: "second", name: "Second" }],
      resolveModelInfo: async () => ({}),
    });
    state.contextServices.set("agentDefaultModel", {
      currentSelection: () => ({ provider: "provider", model: "first" }),
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });
    const nextModel = (catalog.providers as { models: { id: string }[] }[])[0]!.models[1]!.id;
    const lookup = Promise.withResolvers<unknown>();
    state.contextServices.set("llm", {
      listProviders: () => [{ id: "provider", name: "Provider" }],
      listModels: () => lookup.promise,
      resolveModelInfo: async () => ({}),
    });
    const changing = state.agent.setSessionConfigOption!({
      sessionId: created.sessionId,
      configId: "deepseek.model",
      value: nextModel,
    });
    await Promise.resolve();
    await state.agent.closeSession({ sessionId: created.sessionId });
    lookup.resolve([{ id: "second", name: "Second" }]);

    await expect(changing).rejects.toThrow("unknown session");
  });

  it("degrades malformed command discovery without leaking diagnostics", async () => {
    const state = services();
    const secret = "SENTINEL_COMMAND_DISCOVERY";
    state.contextServices.set("commands", {
      list: () => [{ name: "bad command", description: secret }],
      find: () => undefined,
    });

    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const catalog = await state.agent.extMethod("deepseek/catalog", { cwd: "/project" });
    state.invoke("commands/change");
    await expect.poll(() => state.updates.length).toBe(1);

    expect(created.configOptions).toEqual([]);
    expect(catalog.commands).toEqual([]);
    expect(state.updates.at(-1)).toMatchObject({
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    });
    expect(state.diagnostics.join("\n")).toContain("commands/list category=unavailable");
    expect(state.diagnostics.join("\n")).not.toContain(secret);
  });

  it("sanitizes command enumeration exceptions across session paths", async () => {
    const state = services();
    const secret = "SENTINEL_COMMAND_ENUMERATION";
    state.contextServices.set("commands", {
      list: () => {
        throw new Error(secret);
      },
      find: () => undefined,
    });

    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    await state.agent.loadSession({ sessionId: created.sessionId, cwd: "/project", mcpServers: [] });
    state.invoke("commands/change");
    await Promise.resolve();

    expect(state.diagnostics.join("\n")).toContain("commands/list category=unavailable");
    expect(state.diagnostics.join("\n")).not.toContain(secret);
  });

  it("clears stale commands when a loaded session has none", async () => {
    const state = services();
    const meta = header({ id: "no-commands", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("no-commands", { meta, events: [] });

    await state.agent.loadSession({ sessionId: "no-commands", cwd: "/project", mcpServers: [] });

    expect(state.updates).toContainEqual({
      sessionId: "no-commands",
      update: { sessionUpdate: "available_commands_update", availableCommands: [] },
    });
  });

  it("routes only exact advertised slash commands away from the model", async () => {
    const state = services();
    const execute = vi.fn(async (agent: Agent, _line: string) => {
      agent.session.append("command/done", {
        commandId: CommandId("command-1"),
        kind: "success",
        text: "Compacted",
      });
      return { commandId: "command-1", result: { kind: "success", text: "Compacted" } };
    });
    state.contextServices.set("commands", {
      list: () => [{ name: "compact", description: "Compact context" }],
      find: (_agent: Agent, name: string) => (name === "compact" ? {} : undefined),
      execute,
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    state.updates.length = 0;

    await expect(
      state.agent.prompt({
        sessionId: created.sessionId,
        prompt: [
          { type: "text", text: "/compact now" },
          { type: "image", data: "not-base64", mimeType: "image/png" },
        ],
      }),
    ).rejects.toThrow("invalid image base64");
    expect(execute).not.toHaveBeenCalled();

    await expect(
      state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "/compact now" }] }),
    ).resolves.toEqual({ stopReason: "end_turn" });
    expect(execute).toHaveBeenCalledOnce();
    expect(handle.agent.followup).not.toHaveBeenCalled();
    expect(state.updates).toContainEqual({
      sessionId: created.sessionId,
      update: expect.objectContaining({
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text: "Compacted" },
      }),
    });

    const prose = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "/compacting is ordinary prose" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);
    state.invoke("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });
    await expect(prose).resolves.toEqual({ stopReason: "end_turn" });
    expect(execute).toHaveBeenCalledOnce();
  });

  it("sanitizes command execution errors in diagnostics", async () => {
    const state = services();
    const secret = "SENTINEL_COMMAND_ARGUMENT";
    state.contextServices.set("commands", {
      list: () => [{ name: "login", description: "Login" }],
      find: () => ({}),
      execute: async () => {
        throw new Error(`login failed for ${secret}`);
      },
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });

    await expect(
      state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: `/login ${secret}` }] }),
    ).rejects.toThrow("turn output failed");

    expect(state.diagnostics).toContain(
      `sesori-deepseek-acp: session/command session=${created.sessionId} command="login" category=execution_failed\n`,
    );
    expect(state.diagnostics.join("\n")).not.toContain(secret);
    expect(state.diagnostics.join("\n")).not.toContain("login failed for");
  });

  it("settles cancellation when a command ignores its abort signal", async () => {
    const state = services();
    const execution = Promise.withResolvers<unknown>();
    state.contextServices.set("commands", {
      list: () => [{ name: "hang", description: "Hang" }],
      find: () => ({}),
      execute: () => execution.promise,
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const prompt = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "/hang" }],
    });
    await Promise.resolve();

    await state.agent.cancel({ sessionId: created.sessionId });
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("renames live and cold sessions through the title owner", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: created.sessionId,
        title: "Live title",
      }),
    ).resolves.toEqual({ title: "Live title" });
    expect(state.updates.at(-1)).toMatchObject({
      sessionId: created.sessionId,
      update: { sessionUpdate: "session_info_update", title: "Live title" },
    });

    const meta = header({ id: "cold-rename", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("cold-rename", { meta, events: [] });
    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: "cold-rename",
        title: "Cold title",
      }),
    ).resolves.toEqual({ title: "Cold title" });
    expect(state.resume).toHaveBeenCalledWith(expect.objectContaining({ resumeSessionId: "cold-rename" }));
    expect(state.live.has("cold-rename")).toBe(false);
  });

  it("blocks concurrent operations during cold rename inspection", async () => {
    const state = services();
    const meta = header({ id: "rename-inspecting", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("rename-inspecting", { meta, events: [] });
    const inspection = Promise.withResolvers<{ meta: SessionHeader; events: readonly SessionEvent[] }>();
    vi.mocked(state.context.sessionPersistence.inspect).mockReturnValueOnce(inspection.promise);
    const renaming = state.agent.extMethod("deepseek/session/rename", {
      sessionId: "rename-inspecting",
      title: "Cold title",
    });
    await expect.poll(() => vi.mocked(state.context.sessionPersistence.inspect).mock.calls.length).toBe(1);

    await expect(
      state.agent.prompt({ sessionId: "rename-inspecting", prompt: [{ type: "text", text: "question" }] }),
    ).rejects.toThrow("session load is in progress");
    inspection.resolve({ meta, events: [] });
    await expect(renaming).resolves.toEqual({ title: "Cold title" });
  });

  it("clears cold rename transition after inspection failure so retry works", async () => {
    const state = services();
    const meta = header({ id: "rename-retry", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("rename-retry", { meta, events: [] });
    vi.mocked(state.context.sessionPersistence.inspect).mockRejectedValueOnce(new Error("synthetic inspect failure"));

    await expect(
      state.agent.extMethod("deepseek/session/rename", { sessionId: "rename-retry", title: "First" }),
    ).rejects.toThrow("unable to rename DeepSeek session");
    await expect(
      state.agent.extMethod("deepseek/session/rename", { sessionId: "rename-retry", title: "Second" }),
    ).resolves.toEqual({ title: "Second" });
  });

  it("validates cold rename persistence before resuming", async () => {
    const state = services();
    const meta = header({ id: "unlisted-rename", cwd: "/project" });
    state.inspections.set("unlisted-rename", { meta, events: [] });

    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: "unlisted-rename",
        title: "Cold title",
      }),
    ).rejects.toThrow("unknown session");
    expect(state.resume).not.toHaveBeenCalled();
  });

  it("returns a persisted live rename when queued update delivery fails", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    state.sessionUpdate.mockRejectedValueOnce(new Error("synthetic live rename update failure"));

    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: created.sessionId,
        title: "Persisted live title",
      }),
    ).resolves.toEqual({ title: "Persisted live title" });
    expect(state.diagnostics.join("\n")).toContain("deepseek/session/rename update");
    expect(state.diagnostics.join("\n")).toContain("synthetic live rename update failure");
  });

  it("returns a persisted cold rename when update delivery fails", async () => {
    const state = services();
    const meta = header({ id: "rename-update-failure", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("rename-update-failure", { meta, events: [] });
    state.sessionUpdate.mockRejectedValueOnce(new Error("synthetic rename update failure"));

    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: "rename-update-failure",
        title: "Persisted title",
      }),
    ).resolves.toEqual({ title: "Persisted title" });
    expect(state.live.has("rename-update-failure")).toBe(false);
    expect(state.diagnostics.join("\n")).toContain("deepseek/session/rename update session=rename-update-failure");
    expect(state.diagnostics.join("\n")).toContain("synthetic rename update failure");
  });

  it("retains a cold rename handle when disposal fails so close can retry", async () => {
    const state = services();
    const meta = header({ id: "rename-cleanup", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("rename-cleanup", { meta, events: [] });
    const originalResume = state.resume.getMockImplementation() as (...args: unknown[]) => Promise<AgentHandle>;
    state.resume.mockImplementationOnce(async (...args: unknown[]) => {
      const handle = await originalResume(...args);
      vi.mocked(handle.dispose).mockRejectedValueOnce(new Error("synthetic rename cleanup failure"));
      return handle;
    });

    await expect(
      state.agent.extMethod("deepseek/session/rename", {
        sessionId: "rename-cleanup",
        title: "Cold title",
      }),
    ).rejects.toThrow("unable to release renamed DeepSeek session");
    const handle = state.live.get("rename-cleanup")!;

    await expect(state.agent.closeSession({ sessionId: "rename-cleanup" })).resolves.toEqual({});
    expect(handle.dispose).toHaveBeenCalledTimes(2);
    expect(state.live.has("rename-cleanup")).toBe(false);
  });

  it("keeps command updates ordered without failing an active prompt", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const first = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(() => first.promise);
    const completion = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);

    state.invoke("commands/change");
    state.invoke("commands/change");
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);
    first.reject(new Error("synthetic command update failure"));
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(2);
    state.invoke("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    await expect(completion).resolves.toEqual({ stopReason: "end_turn" });
    expect(state.diagnostics.join("\n")).toContain("session/commands update");
  });

  it("keeps later output moving after one client update fails", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const emitted = (state.context as unknown as { __emit(name: string, ...args: unknown[]): void }).__emit;
    const completion = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);
    state.sessionUpdate.mockRejectedValueOnce(new Error("synthetic output failure"));

    emitted("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "first" } },
    });
    emitted("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "second" } },
    });
    emitted("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    await expect(completion).rejects.toThrow("turn output failed");
    expect(state.sessionUpdate).toHaveBeenCalledTimes(2);
    expect((state.updates[0]?.update as { content?: { text?: string } } | undefined)?.content?.text).toBe("second");
  });

  it("projects assistant images, presenter diffs, plans, titles, and compaction status", async () => {
    const state = services();
    state.contextServices.set("attachments", {
      readImage: vi.fn(async () => ({ data: Buffer.from("image"), ref: { mediaType: "image/png" } })),
    });
    state.contextServices.set("tools", {
      get: () => ({
        presentCall: () => ({
          card: "diff",
          title: "Edit file.txt",
          diffs: [{ path: "file.txt", oldText: "old", newText: "new" }],
        }),
        presentResult: () => ({
          card: "diff",
          title: "Edited file.txt",
          diffs: [{ path: "file.txt", oldText: "old", newText: "new" }],
        }),
      }),
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const completion = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);

    state.invoke("session/event", handle.agent.session, {
      type: "assistant/message",
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "assistant",
          role: "assistant",
          source: { kind: "model", provider: "synthetic", model: "synthetic" },
          content: [{ type: "image", attachment: { id: "image" } }],
        },
      },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "edit", arguments: "{}" },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "tool/result",
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "result",
          role: "user",
          source: { kind: "tool", callId: "call-1", tool: "edit" },
          content: [{ type: "tool-result", toolCallId: "call-1", content: [], isError: false }],
        },
      },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "todo/write",
      data: { todos: [{ content: "Ship it", status: "in_progress" }] },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "session/title",
      data: { title: "New title" },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "compaction/start",
      data: { compactionId: "compact-1", turn: 1 },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "llm/retry",
      data: { retry: 1, maxRetries: 3 },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "compaction/end",
      data: { compactionId: "compact-1", turn: 1 },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "turn/end",
      data: { turn: 1, reason: { kind: "completed" } },
    });

    await expect(completion).resolves.toEqual({ stopReason: "end_turn" });
    expect(state.updates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "agent_message_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "session_info_update",
    ]);
    expect((state.updates[1]!.update as { content?: unknown[] }).content).toEqual([
      { type: "diff", path: "file.txt", oldText: "old", newText: "new" },
    ]);
    expect(state.extNotifications.map((item) => item.params.kind)).toEqual([
      "compaction_started",
      "retry",
      "compaction_completed",
    ]);
  });

  it("replays presenter diffs, plans, and titles through the same standard updates", async () => {
    const state = services();
    state.contextServices.set("tools", {
      get: () => ({
        presentCall: () => ({
          card: "diff",
          title: "Edit file.txt",
          diffs: [{ path: "file.txt", oldText: "old", newText: "new" }],
        }),
        presentResult: () => ({
          card: "diff",
          title: "Edited file.txt",
          diffs: [{ path: "file.txt", oldText: "old", newText: "new" }],
        }),
      }),
    });
    const meta = header({ id: "rich-replay", cwd: "/project" });
    state.headers.push(meta);
    state.inspections.set("rich-replay", {
      meta,
      events: [
        {
          type: "user/message",
          seq: 0,
          time: 1,
          surfaceOp: "append",
          data: {
            id: "user-1",
            role: "user",
            source: { kind: "user" },
            content: [{ type: "text", text: "question" }],
          },
        },
        {
          type: "tool/call",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, callId: "call-1", name: "edit", arguments: "{}" },
        },
        {
          type: "tool/result",
          seq: 2,
          time: 3,
          surfaceOp: "append",
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "result",
              role: "user",
              source: { kind: "tool", callId: "call-1", tool: "edit" },
              content: [{ type: "tool-result", toolCallId: "call-1", content: [] }],
            },
          },
        },
        {
          type: "todo/write",
          seq: 3,
          time: 4,
          data: { todos: [{ content: "Ship it", status: "completed" }] },
        },
        { type: "session/title", seq: 4, time: 5, data: { title: "Done" } },
      ] as unknown as SessionEvent[],
    });

    const replay = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "rich-replay",
    });
    const updates = replay.updates as SessionNotification[];
    expect(updates.map((notification) => notification.update.sessionUpdate)).toEqual([
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "plan",
      "session_info_update",
    ]);
    expect((updates[1]!.update as { content?: unknown[] }).content).toEqual([
      { type: "diff", path: "file.txt", oldText: "old", newText: "new" },
    ]);
  });

  it("round trips owned approvals and structured questions", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    state.requestPermission.mockResolvedValueOnce({
      outcome: { outcome: "selected", optionId: "allow-once" },
    });

    await expect(
      state.invoke(
        "approval/request",
        { agent: handle.agent, callId: "call-1", toolName: "edit" },
        async () => "unavailable",
      ),
    ).resolves.toBe("allowed-once");
    expect(state.requestPermission).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: created.sessionId }),
    );

    state.extensionRequest.mockResolvedValueOnce({
      answers: [{ questionId: "q1", selectedLabels: ["Approve"] }],
    });
    await expect(
      state.askQuestion({
        agent: handle.agent,
        questions: [
          {
            id: "q1",
            question: "Proceed?",
            options: [{ label: "Approve" }, { label: "Reject" }],
            intent: { kind: "plan-review", approve: "Approve" },
          },
        ],
      }),
    ).resolves.toEqual({ answers: [{ id: "q1", selected: ["Approve"] }] });
    expect(state.extensionRequest).toHaveBeenCalledWith(
      "deepseek/ask_user_question",
      expect.objectContaining({ sessionId: created.sessionId }),
    );
  });

  it("settles an aborted question without waiting for a late client answer", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const answer = Promise.withResolvers<Record<string, unknown>>();
    state.extensionRequest.mockReturnValueOnce(answer.promise);
    const controller = new AbortController();
    const asking = state.askQuestion({
      agent: handle.agent,
      signal: controller.signal,
      questions: [{ id: "q1", question: "Proceed?" }],
    });
    await expect.poll(() => state.extensionRequest.mock.calls.length).toBe(1);

    controller.abort(new Error("synthetic question abort"));
    await expect(asking).rejects.toThrow("synthetic question abort");
    answer.resolve({ answers: [{ questionId: "q1", selectedLabels: [], customAnswer: "Later" }] });
  });

  it("does not send pre-aborted questions and orders questions after prior output", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const alreadyAborted = new AbortController();
    alreadyAborted.abort(new Error("question already withdrawn"));
    await expect(
      state.askQuestion({
        agent: handle.agent,
        signal: alreadyAborted.signal,
        questions: [{ id: "q1", question: "Obsolete?" }],
      }),
    ).rejects.toThrow("question already withdrawn");
    expect(state.extensionRequest).not.toHaveBeenCalled();

    const output = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(async (notification: SessionNotification) => {
      state.updates.push(notification);
      await output.promise;
    });
    state.invoke("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "Context first" } },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);
    state.extensionRequest.mockResolvedValueOnce({
      answers: [{ questionId: "q2", selectedLabels: [], customAnswer: "Answer" }],
    });
    const asking = state.askQuestion({
      agent: handle.agent,
      questions: [{ id: "q2", question: "Then ask?" }],
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.extensionRequest).not.toHaveBeenCalled();

    output.resolve();
    await expect(asking).resolves.toEqual({
      answers: [{ id: "q2", selected: [], custom: "Answer" }],
    });
  });

  it("waits for tool presentation and aborts an obsolete permission request", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const output = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(async (notification: SessionNotification) => {
      state.updates.push(notification);
      await output.promise;
    });
    const answer = Promise.withResolvers<{ outcome: { outcome: "cancelled" } }>();
    state.requestPermission.mockReturnValueOnce(answer.promise);
    state.invoke("session/event", handle.agent.session, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-1", name: "edit", arguments: "{}" },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);
    const controller = new AbortController();
    const approval = state.invoke(
      "approval/request",
      { agent: handle.agent, callId: "call-1", toolName: "edit", signal: controller.signal },
      async () => "unavailable",
    ) as Promise<unknown>;
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.requestPermission).not.toHaveBeenCalled();

    output.resolve();
    await expect.poll(() => state.requestPermission.mock.calls.length).toBe(1);
    controller.abort(new Error("synthetic approval abort"));
    await expect(approval).resolves.toBe("unavailable");
    answer.resolve({ outcome: { outcome: "cancelled" } });

    const laterOutput = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(async (notification: SessionNotification) => {
      state.updates.push(notification);
      await laterOutput.promise;
    });
    state.invoke("session/event", handle.agent.session, {
      type: "tool/call",
      data: { turn: 1, step: 2, callId: "call-2", name: "edit", arguments: "{}" },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(2);
    const earlyAbort = new AbortController();
    const obsolete = state.invoke(
      "approval/request",
      { agent: handle.agent, callId: "call-2", toolName: "edit", signal: earlyAbort.signal },
      async () => "unavailable",
    ) as Promise<unknown>;
    earlyAbort.abort(new Error("approval withdrawn before presentation"));
    await expect(obsolete).resolves.toBe("unavailable");
    laterOutput.resolve();
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(state.requestPermission).toHaveBeenCalledTimes(1);
  });

  it("does not log malformed raw tool arguments", async () => {
    const state = services();
    state.contextServices.set("tools", { get: () => ({ presentCall: () => undefined }) });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const secret = "SENTINEL_RAW_TOOL_ARGUMENT";

    state.invoke("session/event", handle.agent.session, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-secret", name: "edit", arguments: secret },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);

    expect(state.diagnostics.join("\n")).toContain("tool arguments are not valid JSON");
    expect(state.diagnostics.join("\n")).not.toContain(secret);
  });

  it("does not log payloads included in tool presenter errors", async () => {
    const state = services();
    const secret = "SENTINEL_PRESENTER_PAYLOAD";
    state.contextServices.set("tools", {
      get: () => ({
        presentCall: () => {
          throw new Error(secret);
        },
        presentResult: () => {
          throw new Error(secret);
        },
      }),
    });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    state.invoke("session/event", handle.agent.session, {
      type: "tool/call",
      data: { turn: 1, step: 1, callId: "call-secret", name: "edit", arguments: "{}" },
    });
    state.invoke("session/event", handle.agent.session, {
      type: "tool/result",
      surfaceOp: "append",
      data: {
        turn: 1,
        step: 1,
        message: {
          id: "result-secret",
          role: "user",
          source: { kind: "tool", callId: "call-secret", tool: "edit" },
          content: [{ type: "tool-result", toolCallId: "call-secret", content: [{ type: "text", text: secret }] }],
        },
      },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(2);

    expect(state.diagnostics.join("\n")).toContain("tool call presenter failed");
    expect(state.diagnostics.join("\n")).toContain("tool result presenter failed");
    expect(state.diagnostics.join("\n")).not.toContain(secret);
  });

  it("makes close drain pending prompt output and unregisters the question provider", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const output = Promise.withResolvers<void>();
    state.sessionUpdate.mockImplementationOnce(async (notification: SessionNotification) => {
      state.updates.push(notification);
      await output.promise;
    });
    const prompt = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);
    state.invoke("session/event", handle.agent.session, {
      type: "assistant/chunk",
      data: { turn: 1, step: 1, chunk: { type: "text-delta", index: 0, text: "pending" } },
    });
    await expect.poll(() => state.sessionUpdate.mock.calls.length).toBe(1);
    let closeCompleted = false;
    const closing = state.agent.closeSession({ sessionId: created.sessionId }).then(() => {
      closeCompleted = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(closeCompleted).toBe(false);

    output.resolve();
    await closing;
    await expect(prompt).resolves.toEqual({ stopReason: "cancelled" });
    await state.agent.dispose();
    expect(() => state.askQuestion({ agent: handle.agent, questions: [] })).toThrow(
      "question provider is unavailable",
    );
  });

  it("rejects a concurrent prompt and cancels exact session admission", async () => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const idle = Promise.withResolvers<void>();
    vi.mocked(handle.agent.whenIdle).mockReturnValue(idle.promise);
    const pending = state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "one" }] });
    await expect(
      state.agent.prompt({ sessionId: created.sessionId, prompt: [{ type: "text", text: "two" }] }),
    ).rejects.toThrow("already in flight");
    await state.agent.cancel({ sessionId: created.sessionId });
    idle.resolve();
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
  });

  it("cancels image admission before the message is queued", async () => {
    const state = services();
    const saved = Promise.withResolvers<readonly unknown[]>();
    const saveImages = vi.fn(() => saved.promise);
    state.contextServices.set("attachments", { saveImages });
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const pending = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
    });
    await expect.poll(() => saveImages.mock.calls.length).toBe(1);

    await state.agent.cancel({ sessionId: created.sessionId });
    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
    expect(handle.agent.followup).not.toHaveBeenCalled();
    saved.resolve([{ id: "saved-image" }]);
  });

  it.each([
    ["blocked", "refusal"],
    ["aborted", "cancelled"],
  ] as const)("maps %s turn settlement to %s", async (kind, stopReason) => {
    const state = services();
    const created = await state.agent.newSession({ cwd: "/project", mcpServers: [] });
    const handle = state.live.get(created.sessionId)!;
    const pending = state.agent.prompt({
      sessionId: created.sessionId,
      prompt: [{ type: "text", text: "question" }],
    });
    await expect.poll(() => vi.mocked(handle.agent.followup).mock.calls.length).toBe(1);

    state.invoke("session/event", handle.agent.session, {
      type: "turn/end",
      data: {
        turn: 1,
        reason: kind === "aborted" ? { kind, reason: { kind: "user" } } : { kind },
      },
    });

    await expect(pending).resolves.toEqual({ stopReason });
  });

  it("replays tool identity and status without exposing raw arguments or results", async () => {
    const state = services();
    const meta = header({ id: "tools", cwd: "/project" });
    const sentinel = "SENTINEL_RAW_TOOL_CONTENT";
    state.headers.push(meta);
    state.inspections.set("tools", {
      meta,
      events: [
        {
          type: "assistant/message",
          seq: 0,
          time: 1,
          surfaceOp: "append",
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "assistant-tool",
              role: "assistant",
              source: { kind: "model", provider: "synthetic", model: "synthetic" },
              content: [
                { type: "tool-call", id: "call-1", name: "read_file", arguments: sentinel },
              ],
            },
          },
        },
        {
          type: "tool/call",
          seq: 1,
          time: 2,
          data: { turn: 1, step: 1, callId: "call-1", name: "read_file", arguments: sentinel },
        },
        {
          type: "tool/result",
          seq: 2,
          time: 3,
          surfaceOp: "append",
          sourceEventSeqs: [1],
          data: {
            turn: 1,
            step: 1,
            message: {
              id: "tool-result-1",
              role: "user",
              source: { kind: "tool", callId: "call-1", tool: "read_file" },
              content: [
                {
                  type: "tool-result",
                  toolCallId: "call-1",
                  content: [{ type: "text", text: sentinel }],
                },
              ],
            },
          },
        },
      ] as unknown as SessionEvent[],
    });

    const response = await state.agent.extMethod("deepseek/session/history", {
      sessionId: "tools",
      maxMessages: 1,
    });
    expect(JSON.stringify(response)).not.toContain(sentinel);
    expect(response.updates).toEqual([
      {
        sessionId: "tools",
        update: {
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          title: "read_file",
          status: "in_progress",
        },
      },
      {
        sessionId: "tools",
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: "call-1",
          status: "completed",
        },
      },
    ]);
  });
});
