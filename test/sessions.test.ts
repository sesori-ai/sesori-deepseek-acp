import type { AgentSideConnection, SessionNotification } from "@agentclientprotocol/sdk";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
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
  let questionProvider: { ask(request: unknown): Promise<unknown> } | undefined;
  const makeHandle = (meta: SessionHeader, sessionEvents: readonly SessionEvent[]): AgentHandle => {
    const agent = {
      id: meta.id,
      session: { id: meta.id, header: meta, events: sessionEvents },
      status: "idle",
      followup: vi.fn((message: unknown) => {
        for (const listener of listeners.get("agent/inbox/claimed") ?? []) listener({ agent, message, turn: 1 } as never);
      }),
      cancel: vi.fn(),
      whenIdle: vi.fn(async () => undefined),
    };
    const handle = {
      agent,
      dispose: vi.fn(async () => {
        live.delete(String(meta.id));
      }),
    } as unknown as AgentHandle;
    live.set(String(meta.id), handle);
    return handle;
  };
  const create = vi.fn(async (options: { sessionId: string; meta: { cwd: string } }) => {
    return makeHandle(header({ id: options.sessionId, cwd: options.meta.cwd }), []);
  });
  const resume = vi.fn(async (options: { resumeSessionId: string }) => {
    const inspection = inspections.get(options.resumeSessionId);
    if (inspection === undefined) throw new Error("not found");
    return makeHandle(inspection.meta, inspection.events);
  });
  const context = {
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
    sessionPersistence: {
      list: vi.fn(async () => [...headers]),
      inspect: vi.fn(async (id: string) => {
        const inspection = inspections.get(id);
        if (inspection === undefined) throw new Error("not found");
        return inspection;
      }),
    },
    get: (name: string) => contextServices.get(name),
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
    ]);

    await state.agent.loadSession({ sessionId: "cold", cwd: "/project", mcpServers: [] });
    expect(state.resume).toHaveBeenCalledOnce();
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
    state.resume.mockImplementationOnce(async () => {
      resumed.resolve();
      await release.promise;
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
    state.resume.mockImplementationOnce(async () => {
      resumed.resolve();
      await release.promise;
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
    state.resume.mockImplementationOnce(async () => {
      resumed.resolve();
      await release.promise;
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
        totalTokens: 17,
      },
    });
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
    saved.resolve([{ id: "saved-image" }]);

    await expect(pending).resolves.toEqual({ stopReason: "cancelled" });
    expect(handle.agent.followup).not.toHaveBeenCalled();
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
