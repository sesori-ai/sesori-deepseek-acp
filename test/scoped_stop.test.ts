import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentSideConnection } from "@agentclientprotocol/sdk";
import type { Agent, CreateAgentOptions } from "@deepseek-ai/dsh-agent";
import { CallId, createUserMessage } from "@deepseek-ai/dsh-llm";
import { SessionId } from "@deepseek-ai/dsh-session";
import type { JobKind, JobOutcome } from "@deepseek-ai/dsh-jobs";
import type {} from "@deepseek-ai/dsh-user-questions";
import { afterEach, expect, it, vi } from "vitest";
import { bootRuntime } from "../src/runtime.ts";
import { DurableSessionAgent } from "../src/sessions.ts";
import { createMemorySubagentBindingStore } from "../src/subagent_bindings.ts";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function harness() {
  const dir = await mkdtemp(join(tmpdir(), "scoped-stop-"));
  const home = join(dir, "home");
  const project = join(dir, "project");
  await cp(new URL("./fixtures/dsh-home", import.meta.url), home, { recursive: true });
  await mkdir(project);
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = home;
  const context = await bootRuntime({ stateDir: join(dir, "state"), workspaceRoot: project });
  const diagnostics: string[] = [];
  const notifications: Record<string, unknown>[] = [];
  const output = Promise.withResolvers<void>();
  const signals = new Map<Agent, AbortSignal>();
  const beforeStep = new Map<Agent, (signal: AbortSignal) => Promise<unknown>>();
  const requests: { method: string; id?: number | string; params: Record<string, unknown> }[] = [];
  let input!: ReadableStreamDefaultController<never>;
  let adapter!: DurableSessionAgent;
  const connection = new AgentSideConnection((connection) => {
    adapter = new DurableSessionAgent({ context, connection,
      diagnostics: { write: (message) => diagnostics.push(message) }, bindings: createMemorySubagentBindingStore() });
    return adapter;
  }, {
    readable: new ReadableStream({ start(controller) { input = controller; } }),
    writable: new WritableStream({ write(message) {
      if ("method" in message && "params" in message) requests.push(message as typeof requests[number]);
    } }),
  });
  // Real SDK writer for interactions; controlled ACP announcement/output barrier.
  vi.spyOn(connection, "extNotification").mockImplementation(async (_method, params) => {
    await output.promise;
    notifications.push(params);
  });
  context.on("agent/pre-step", async ({ agent, signal }) => {
    signals.set(agent, signal);
    await beforeStep.get(agent)?.(signal);
    if (!signal.aborted) await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve(), { once: true }));
    throw signal.reason;
  });
  cleanups.push(async () => {
    output.resolve();
    input.close();
    await adapter.dispose();
    await context.fiber.dispose();
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  async function root() {
    const { sessionId } = await adapter.newSession({ cwd: project, mcpServers: [] });
    return context.agents.get(SessionId(sessionId))!;
  }
  const stop = (target: Agent, parent?: Agent) => adapter.extMethod("deepseek/session/stop", parent === undefined
    ? { kind: "session", sessionId: String(target.id) }
    : { kind: "child", sessionId: String(parent.id), childSessionId: String(target.id) });
  const nativeScopes = new Set<Agent>();
  const launch = (args: { parent: Agent; signal: AbortSignal; fork?: boolean; foreground?: boolean }) => {
    if (!nativeScopes.has(args.parent)) {
      args.parent.ctx.tools.presentAs("native");
      nativeScopes.add(args.parent);
    }
    return context.tools.execute({
    agent: args.parent, signal: args.signal, callId: CallId(crypto.randomUUID()),
    name: args.fork ? "subagent_fork" : "subagent",
    arguments: { description: "child", prompt: "wait", run_in_background: !args.foreground },
    });
  };
  async function child(args: { parent: Agent; signal: AbortSignal }) {
    const result = await launch(args);
    expect(result.isError, JSON.stringify(result)).not.toBe(true);
    const childId = (result.value as { subagentId: string }).subagentId;
    const agent = context.agents.get(SessionId(childId))!;
    await expect.poll(() => signals.has(agent)).toBe(true);
    return agent;
  }
  function job(args: { owner?: Agent; kind?: JobKind; fail?: boolean }) {
    const done = Promise.withResolvers<JobOutcome>();
    const cancel = vi.fn(() => {
      if (args.fail) throw new Error("producer sentinel failure");
      done.resolve({ status: "killed" });
    });
    const id = context.jobs.start({ kind: args.kind ?? "subagent", label: "test job",
      ...(args.owner === undefined ? {} : { owner: args.owner }), run: () => ({ cancel, done: done.promise }) });
    return { id, cancel, done };
  }
  return { context, adapter, connection, root, stop, launch, child, signals, beforeStep, output, notifications, requests, diagnostics, job };
}

it("signals nested native children before delayed root/child announcements and preserves later work", async () => {
  const h = await harness();
  const root = await h.root();
  const child = await h.child({ parent: root, signal: new AbortController().signal });
  const grandchild = await h.child({ parent: child, signal: h.signals.get(child)! });
  child.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "old queued" }] }));
  expect(child.inbox.hasPending).toBe(true);
  expect(h.notifications).toEqual([]);
  const stopping = h.stop(root);
  // No microtask, output ACK, idle wait, or disposal has run since dispatch.
  expect(h.signals.get(child)!.aborted).toBe(true);
  expect(h.signals.get(grandchild)!.aborted).toBe(true);
  expect(child.inbox.hasPending).toBe(false);
  await expect(stopping).resolves.toEqual({ workKept: false });
  const later = await h.child({ parent: root, signal: new AbortController().signal });
  expect(h.signals.get(later)!.aborted).toBe(false);
  await h.stop(root);
});

it("checks exact parent authority and cancels only the named subtree and its owned subagent jobs", async () => {
  const h = await harness();
  const root = await h.root();
  const child = await h.child({ parent: root, signal: new AbortController().signal });
  const sibling = await h.child({ parent: root, signal: new AbortController().signal });
  const grandchild = await h.child({ parent: child, signal: h.signals.get(child)! });
  const jobs = [h.job({ owner: root }), h.job({ owner: child }), h.job({ owner: grandchild }),
    h.job({ owner: sibling }), h.job({ owner: child, kind: "bash" }), h.job({})];
  await expect(h.stop(child, sibling)).rejects.toThrow("not owned");
  expect(jobs.every((job) => job.cancel.mock.calls.length === 0)).toBe(true);
  const stopping = h.stop(child, root);
  expect(h.signals.get(child)!.aborted).toBe(true);
  expect(h.signals.get(grandchild)!.aborted).toBe(true);
  expect(h.signals.get(sibling)!.aborted).toBe(false);
  expect(jobs.map((job) => job.cancel.mock.calls.length)).toEqual([0, 1, 1, 0, 0, 0]);
  await expect(stopping).resolves.toEqual({ workKept: false });
  await h.stop(root);
});

for (const fork of [false, true]) {
  for (const foreground of [false, true]) {
    it(`covers pending ${fork ? "fork" : "spawn"} ${foreground ? "foreground handoff" : "background admission"}`, async () => {
      const h = await harness();
      const root = await h.root();
      const published = Promise.withResolvers<Agent>();
      const release = Promise.withResolvers<void>();
      const create = h.context.agents.create.bind(h.context.agents);
      vi.spyOn(h.context.agents, "create").mockImplementation(async (options: CreateAgentOptions) => {
        const handle = await create(options);
        published.resolve(handle.agent);
        await release.promise;
        return handle;
      });
      let launching!: ReturnType<typeof h.launch>;
      const maintenance = root.runMaintenance(async (signal) => {
        launching = h.launch({ parent: root, signal, fork, foreground });
        await launching;
      });
      const child = await published.promise;
      // The real child registry has published, but the caller has not crossed
      // continuable admission / foreground signal handoff. Background forks are
      // already in the real synchronous owned-job registry at this boundary.
      const followup = vi.spyOn(child, "followup");
      const stopping = h.stop(root);
      if (fork && !foreground) expect(h.context.jobs.list(root).filter((job) => job.kind === "subagent")[0]?.status).toBe("stopping");
      await expect(stopping).resolves.toEqual({ workKept: false });
      release.resolve();
      await maintenance;
      await launching;
      await expect.poll(() => h.context.agents.get(child.id)).toBeUndefined();
      expect(followup).not.toHaveBeenCalled();
    });
  }
}

it("cancels a published background fork via the exact launcher's job, not its parent signal", async () => {
  const h = await harness();
  const root = await h.root();
  const caller = new AbortController();
  const result = await h.launch({ parent: root, signal: caller.signal, fork: true });
  expect(result.isError, JSON.stringify(result)).not.toBe(true);
  await expect.poll(() => h.signals.size).toBe(1);
  const child = [...h.signals.keys()][0]!;
  caller.abort();
  expect(h.signals.get(child)!.aborted).toBe(false);
  await expect(h.stop(child, root)).resolves.toEqual({ workKept: true });
  expect(h.signals.get(child)!.aborted).toBe(false);
  const stopping = h.stop(root);
  expect(h.signals.get(child)!.aborted).toBe(true);
  await expect(stopping).resolves.toEqual({ workKept: false });
});

it("continues independent cancellation after a throwing job and preserves original cause", async () => {
  const h = await harness();
  const root = await h.root();
  const first = h.job({ owner: root, fail: true });
  const second = h.job({ owner: root });
  const child = await h.child({ parent: root, signal: new AbortController().signal });
  const stopping = h.stop(root);
  expect(h.signals.get(child)!.aborted).toBe(true);
  expect(second.cancel).toHaveBeenCalledOnce();
  await expect(stopping).rejects.toMatchObject({ errors: [expect.objectContaining({ cause: expect.objectContaining({ message: "producer sentinel failure" }) })] });
  expect(h.diagnostics.join("\n")).toContain(`job=${first.id}`);
  expect(h.diagnostics.join("\n")).toContain("producer sentinel failure");
  first.done.resolve({ status: "failed" });
});

it("orders old input, cancel SERVER REQUEST, new reused-id input through the real SDK without either ACK", async () => {
  const h = await harness();
  const root = await h.root();
  const args = { questions: [{ id: "reused", question: "Proceed?" }] };
  const first = root.runMaintenance((signal) => h.context.userQuestions.ask({ ...args, agent: root, signal }));
  const firstRejected = expect(first).rejects.toBeDefined();
  await expect.poll(() => h.requests.filter((request) => request.method === "deepseek/ask_user_question").length).toBe(1);
  await expect(h.stop(root)).resolves.toEqual({ workKept: false });
  await firstRejected;
  const second = root.runMaintenance((signal) => h.context.userQuestions.ask({ ...args, agent: root, signal }));
  const secondRejected = expect(second).rejects.toBeDefined();
  await expect.poll(() => h.requests.filter((request) => request.method.startsWith("deepseek/")).length).toBe(3);
  const ordered = h.requests.filter((request) => request.method.startsWith("deepseek/"));
  expect(ordered.map((request) => request.method)).toEqual(["deepseek/ask_user_question", "deepseek/input/cancel", "deepseek/ask_user_question"]);
  expect(ordered[1]).toMatchObject({ id: expect.any(Number), params: { sessionId: String(root.id) } });
  expect(ordered[0]!.params).toEqual(ordered[2]!.params);
  await h.stop(root);
  await secondRejected;
});

for (const identity of ["missing", "inherited", "own", "wrong-origin"] as const) {
  it(`uses live own-suffix descriptor provenance: ${identity}`, async () => {
    const h = await harness();
    const root = await h.root();
    const inherited = identity === "inherited";
    const handle = await h.context.agents.create({
      sessionId: SessionId(crypto.randomUUID()),
      meta: { cwd: root.session.header.cwd!, parentSession: root.id,
        ...(identity === "wrong-origin" ? {} : { origin: "subagent" as const }),
        ...(inherited ? { seedLength: 1 } : {}) },
      ...(inherited ? { seed: [{ type: "subagent/descriptor" as const, seq: 0, time: 1,
        data: { version: 2 as const, mode: "continuable" as const, provider: "spawn", label: "ancestor" } }] } : {}),
    });
    cleanups.push(() => handle.dispose());
    const child = handle.agent;
    if (identity === "own" || identity === "wrong-origin") child.session.append("subagent/descriptor", {
      version: 2, mode: "continuable", provider: "spawn", label: "own",
    });
    // Real live event adoption, deliberately no presentation-mode announcement.
    child.session.append("session/title", { title: "child", messageSeqs: [], source: { kind: "user" } });
    let signal!: AbortSignal;
    const activity = child.runMaintenance(async (active) => {
      signal = active;
      await new Promise<void>((resolve) => active.addEventListener("abort", () => resolve(), { once: true }));
    });
    const cancel = vi.spyOn(child, "cancel");
    await expect(h.stop(child, root)).resolves.toEqual({ workKept: identity !== "own" });
    expect(signal.aborted).toBe(identity === "own");
    expect(cancel.mock.calls.length).toBe(identity === "own" ? 1 : 0);
    child.cancel({ kind: "user" });
    await activity;
  });
}

it("settles pending permissions and logs unsupported input-cancel without blocking later output", async () => {
  const h = await harness();
  const root = await h.root();
  const raw = Promise.withResolvers<Awaited<ReturnType<AgentSideConnection["requestPermission"]>>>();
  vi.spyOn(h.connection, "requestPermission").mockReturnValue(raw.promise);
  const extension = vi.spyOn(h.connection, "extMethod").mockRejectedValue(new Error("Method not found"));
  h.beforeStep.set(root, (signal) => h.context.approval.request({
    agent: root, signal, callId: CallId("permission"), toolName: "edit", reason: "edit file",
  }));
  root.followup(createUserMessage({ source: { kind: "user" }, content: [{ type: "text", text: "ask" }] }));
  const activity = root.whenIdle();
  await expect.poll(() => vi.mocked(h.connection.requestPermission).mock.calls.length).toBe(1);
  await expect(h.stop(root)).resolves.toEqual({ workKept: false });
  await activity;
  await expect.poll(() => h.diagnostics.join("\n")).toContain("Method not found");
  expect(extension).toHaveBeenCalledWith("deepseek/input/cancel", { sessionId: String(root.id) });
  root.session.append("session/title", { title: "after abort", messageSeqs: [], source: { kind: "user" } });
  await expect.poll(() => h.requests.some((request) => request.method === "session/update" &&
    (request.params.update as { title?: string }).title === "after abort")).toBe(true);
});

it("stops live delegates through an ended retained one-shot ancestor", async () => {
  const h = await harness();
  const root = await h.root();
  const foreground = root.runMaintenance((signal) => h.launch({ parent: root, signal, foreground: true }));
  await expect.poll(() => h.signals.size).toBe(1);
  const child = [...h.signals.keys()][0]!;
  const grandchild = await h.child({ parent: child, signal: h.signals.get(child)! });
  child.cancel({ kind: "user" });
  await foreground;
  await expect.poll(() => h.context.agents.get(child.id)).toBeUndefined();
  expect(h.signals.get(grandchild)!.aborted).toBe(false);
  const stopping = h.stop(child, root);
  expect(h.signals.get(grandchild)!.aborted).toBe(true);
  await expect(stopping).resolves.toEqual({ workKept: false });
});

it("retains independently named foreground work but parent stop covers the published signal handoff", async () => {
  const h = await harness();
  const root = await h.root();
  const foreground = root.runMaintenance((signal) => h.launch({ parent: root, signal, foreground: true }));
  await expect.poll(() => h.signals.size).toBe(1);
  const child = [...h.signals.keys()][0]!;
  await expect(h.stop(child, root)).resolves.toEqual({ workKept: true });
  expect(h.signals.get(child)!.aborted).toBe(false);
  const stopping = h.stop(root);
  expect(h.signals.get(child)!.aborted).toBe(true);
  await expect(stopping).resolves.toEqual({ workKept: false });
  await foreground;
  await expect(h.stop(root)).resolves.toEqual({ workKept: false });
  await expect(h.adapter.extMethod("deepseek/session/stop", { kind: "session", sessionId: "absent" })).rejects.toThrow("not owned");
});

it("continues independent child cancellation when another child's cancel hook throws", async () => {
  const h = await harness();
  const root = await h.root();
  const first = await h.child({ parent: root, signal: new AbortController().signal });
  const second = await h.child({ parent: root, signal: new AbortController().signal });
  const failure = new Error("child cancel sentinel");
  const cancel = vi.spyOn(first, "cancel").mockImplementation(() => { throw failure; });
  const stopping = h.stop(root);
  expect(h.signals.get(first)!.aborted).toBe(false);
  expect(h.signals.get(second)!.aborted).toBe(true);
  await expect(stopping).rejects.toMatchObject({ errors: [expect.objectContaining({ cause: failure })] });
  cancel.mockRestore();
  await h.stop(root);
});

it("removes the sent interaction's abort callback after its answer settles", async () => {
  const h = await harness();
  const root = await h.root();
  const extension = vi.spyOn(h.connection, "extMethod").mockResolvedValue({
    answers: [{ questionId: "q", selectedLabels: [], customAnswer: "yes" }],
  });
  const controller = new AbortController();
  await h.context.userQuestions.ask({ questions: [{ id: "q", question: "Proceed?" }],
    agent: root, signal: controller.signal,
  });
  controller.abort();
  await Promise.resolve();
  expect(extension).toHaveBeenCalledTimes(1);
  expect(extension.mock.calls[0]![0]).toBe("deepseek/ask_user_question");
});
