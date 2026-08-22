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
  const makeHandle = (meta: SessionHeader, sessionEvents: readonly SessionEvent[]): AgentHandle => {
    const handle = {
      agent: { session: { id: meta.id, header: meta, events: sessionEvents } },
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
    agents: {
      create,
      resume,
      get: (id: string) => live.get(id)?.agent,
    },
    sessionPersistence: {
      list: vi.fn(async () => [...headers]),
      inspect: vi.fn(async (id: string) => {
        const inspection = inspections.get(id);
        if (inspection === undefined) throw new Error("not found");
        return inspection;
      }),
    },
    get: () => undefined,
  } as unknown as Context;
  const updates: SessionNotification[] = [];
  const connection = {
    sessionUpdate: vi.fn(async (notification: SessionNotification) => {
      updates.push(notification);
    }),
  } as unknown as AgentSideConnection;
  const diagnostics: string[] = [];
  const agent = new DurableSessionAgent({
    context,
    connection,
    diagnostics: { write: (message) => diagnostics.push(message) },
  });
  return { context, headers, inspections, live, create, resume, updates, diagnostics, agent };
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
          messageId: "assistant-1",
          content: { type: "text", text: "thought" },
        },
      },
      {
        sessionId: "cold",
        update: {
          sessionUpdate: "agent_message_chunk",
          messageId: "assistant-1",
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
    await state.agent.dispose();
    release.resolve();

    await expect(loading).rejects.toThrow("unable to load DeepSeek session");
    expect(dispose).toHaveBeenCalledOnce();
    expect(state.live.has("raced")).toBe(false);
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

  it("rejects control characters in session ids before diagnostics", async () => {
    const state = services();

    await expect(
      state.agent.loadSession({ sessionId: "forged\nlog", cwd: "/project", mcpServers: [] }),
    ).rejects.toThrow("invalid session id");
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
