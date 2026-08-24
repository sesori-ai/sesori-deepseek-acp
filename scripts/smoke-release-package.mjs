import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createInterface } from "node:readline";

const requestTimeoutMilliseconds = 30_000;

function timeout(promise, operation) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Timed out during packaged ${operation}`)), requestTimeoutMilliseconds);
    }),
  ]).finally(() => clearTimeout(timer));
}

function launcherCommand({ launcher, target, arguments_ }) {
  if (!target.startsWith("windows-")) return { command: launcher, arguments_ };
  const commandLine = [launcher, ...arguments_]
    .map((value) => `"${value.replaceAll('"', '""')}"`)
    .join(" ");
  return {
    command: process.env.ComSpec ?? "cmd.exe",
    arguments_: ["/d", "/s", "/c", commandLine],
  };
}

function startAcpProcess({ launcher, target, stateDir, environment, cwd }) {
  const invocation = launcherCommand({
    launcher,
    target,
    arguments_: ["serve", "--state-dir", stateDir],
  });
  const child = spawn(invocation.command, invocation.arguments_, {
    cwd,
    env: environment,
    stdio: ["pipe", "pipe", "pipe"],
  });
  const pending = new Map();
  const notifications = [];
  let nextId = 1;
  let stderr = "";
  let protocolFailure;
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const fail = (error) => {
    protocolFailure ??= error;
    for (const request of pending.values()) request.reject(error);
    pending.clear();
  };
  const lines = createInterface({ input: child.stdout });
  lines.on("line", (line) => {
    try {
      const message = JSON.parse(line);
      if (message.id !== undefined && pending.has(message.id)) {
        const request = pending.get(message.id);
        pending.delete(message.id);
        if (message.error === undefined) request.resolve(message.result);
        else request.reject(new Error(`ACP ${request.method} failed: ${JSON.stringify(message.error)} stderr=${stderr}`));
      } else {
        notifications.push(message);
      }
    } catch (error) {
      fail(new Error(`Non-NDJSON content on packaged stdout: ${line}`, { cause: error }));
    }
  });
  child.on("error", fail);
  child.on("exit", (code, signal) => {
    if (pending.size > 0) fail(new Error(`Packaged ACP exited early: code=${String(code)} signal=${String(signal)} stderr=${stderr}`));
  });

  return {
    notifications,
    request(method, params) {
      if (protocolFailure !== undefined) return Promise.reject(protocolFailure);
      const id = nextId++;
      const response = new Promise((resolve, reject) => pending.set(id, { method, resolve, reject }));
      child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return timeout(response, method);
    },
    async stop() {
      child.stdin.end();
      const exit = await timeout(new Promise((resolve) => child.once("exit", (code, signal) => resolve({ code, signal }))), "shutdown");
      if (protocolFailure !== undefined) throw protocolFailure;
      if (exit.code !== 0) throw new Error(`Packaged ACP shutdown failed: ${JSON.stringify(exit)} stderr=${stderr}`);
    },
  };
}

function expect(condition, message) {
  if (!condition) throw new Error(message);
}

async function initialize(client) {
  const result = await client.request("initialize", {
    protocolVersion: 1,
    clientCapabilities: {},
    clientInfo: { name: "sesori-release-smoke", version: "1.0.0" },
  });
  expect(result.protocolVersion === 1, "Packaged initialize returned the wrong ACP version");
  expect(result.agentCapabilities?.loadSession === true, "Packaged initialize omitted loadSession");
  expect(result.agentCapabilities?.sessionCapabilities?.list !== undefined, "Packaged initialize omitted session/list");
  expect(result.agentCapabilities?.sessionCapabilities?.close !== undefined, "Packaged initialize omitted session/close");
}

function messageText(notification) {
  const update = notification?.params?.update;
  if (update?.sessionUpdate !== "user_message_chunk" && update?.sessionUpdate !== "agent_message_chunk") return undefined;
  return update.content?.type === "text" ? update.content.text : undefined;
}

async function exerciseFirstProcess({ client, workspace }) {
  await initialize(client);
  const initial = await client.request("session/list", {});
  expect(Array.isArray(initial.sessions) && initial.sessions.length === 0, "Fresh packaged state contained sessions");
  const created = await client.request("session/new", { cwd: workspace, mcpServers: [] });
  expect(typeof created.sessionId === "string" && created.sessionId.length > 0, "Packaged session/new omitted its id");
  const prompted = await client.request("session/prompt", {
    sessionId: created.sessionId,
    prompt: [{ type: "text", text: "fixture prompt" }],
    _meta: { "sesori.ai/deepseek": { messageId: "release-smoke-user" } },
  });
  expect(prompted.stopReason === "end_turn", "Packaged deterministic prompt did not complete");
  expect(client.notifications.some((message) => messageText(message)?.includes("fixture reply")), "Packaged prompt did not stream fixture output");
  const history = await client.request("deepseek/session/history", {
    sessionId: created.sessionId,
    maxMessages: 50,
  });
  expect(history.hasMore === false, "Packaged history unexpectedly paginated the fixture turn");
  expect(history.updates.some((update) => messageText({ params: update }) === "fixture prompt"), "Packaged history omitted the user message");
  expect(history.updates.some((update) => messageText({ params: update })?.includes("fixture reply")), "Packaged history omitted the assistant message");
  await client.request("session/close", { sessionId: created.sessionId });
  return created.sessionId;
}

async function exerciseRestart({ client, workspace, sessionId }) {
  await initialize(client);
  const listed = await client.request("session/list", {});
  expect(listed.sessions.some((session) => session.sessionId === sessionId), "Restarted package did not list persisted session");
  const notificationsBeforeLoad = client.notifications.length;
  await client.request("session/load", { sessionId, cwd: workspace, mcpServers: [] });
  const replay = client.notifications.slice(notificationsBeforeLoad);
  expect(replay.some((message) => messageText(message) === "fixture prompt"), "Packaged load omitted persisted user replay");
  expect(replay.some((message) => messageText(message)?.includes("fixture reply")), "Packaged load omitted persisted assistant replay");
  await client.request("session/close", { sessionId });
}

async function startProviderFixture() {
  const requests = [];
  const errors = [];
  const server = createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      try {
        const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        expect(request.url === "/chat/completions", `Unexpected provider fixture path: ${String(request.url)}`);
        expect(request.headers.authorization === "Bearer fixture-key", "Provider fixture received the wrong credential");
        expect(body.model === "deepseek-v4-flash" && body.stream === true, "Provider fixture received the wrong model request");
        requests.push(body);
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end([
          'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{"role":"assistant","content":"fixture reply"},"finish_reason":null}]}',
          "",
          'data: {"id":"fixture","object":"chat.completion.chunk","created":1,"model":"deepseek-v4-flash","choices":[{"index":0,"delta":{},"finish_reason":"stop"}],"usage":{"prompt_tokens":3,"completion_tokens":2,"total_tokens":5}}',
          "",
          "data: [DONE]",
          "",
          "",
        ].join("\n"));
      } catch (error) {
        errors.push(error);
        console.error("Provider fixture rejected packaged request:", error);
        response.writeHead(500).end();
      }
    });
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("Provider fixture did not bind TCP");
  return {
    port: address.port,
    verify() {
      if (errors.length > 0) throw errors[0];
      expect(requests.some((body) => JSON.stringify(body.messages).includes("fixture prompt")), "Packaged prompt did not reach the provider fixture");
    },
    close: () => new Promise((resolve, reject) => server.close((error) => error === undefined ? resolve() : reject(error))),
  };
}

export async function smokeAcpLifecycle({ launcher, target, packageRoot, temporaryRoot, environment }) {
  const [provider] = await Promise.all([
    startProviderFixture(),
    mkdir(join(temporaryRoot, "workspace"), { recursive: true }),
    mkdir(join(temporaryRoot, "state"), { recursive: true }),
    mkdir(join(temporaryRoot, "home"), { recursive: true }),
  ]);
  const workspace = join(temporaryRoot, "workspace");
  const stateDir = join(temporaryRoot, "state");
  const home = join(temporaryRoot, "home");
  const settings = [
    "llm-deepseek:",
    `  baseURL: http://127.0.0.1:${provider.port}`,
    "  thinking: disabled",
    "  reasoningEffort: off",
    "  models:",
    "    - id: deepseek-v4-flash",
    "      name: Fixture",
    "      contextWindow: 4096",
    "      maxTokens: 64",
    "      inputModalities: [text]",
    "",
  ].join("\n");
  await writeFile(join(home, "settings.yaml"), settings);
  const isolatedEnvironment = { ...environment, DSH_HOME: home, DEEPSEEK_API_KEY: "fixture-key" };
  try {
    const first = startAcpProcess({ launcher, target, stateDir, environment: isolatedEnvironment, cwd: packageRoot });
    const sessionId = await exerciseFirstProcess({ client: first, workspace });
    await first.stop();
    const restarted = startAcpProcess({ launcher, target, stateDir, environment: isolatedEnvironment, cwd: packageRoot });
    await exerciseRestart({ client: restarted, workspace, sessionId });
    await restarted.stop();
    provider.verify();
    expect(await readFile(join(home, "settings.yaml"), "utf8") === settings, "Packaged runtime changed DeepSeek settings");
    const homeEntries = (await readdir(home)).sort();
    expect(JSON.stringify(homeEntries) === JSON.stringify([".anonymous-user-id", "settings.yaml"]), `Packaged runtime wrote unexpected state into DSH_HOME: ${homeEntries.join(", ")}`);
    expect(/^[0-9a-f-]{36}\n$/iu.test(await readFile(join(home, ".anonymous-user-id"), "utf8")), "Packaged runtime wrote an invalid upstream anonymous id");
  } finally {
    await provider.close();
  }
}
