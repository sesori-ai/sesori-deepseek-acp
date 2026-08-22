import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { PROTOCOL_VERSION } from "@agentclientprotocol/sdk";
import { Context } from "@deepseek-ai/cordis";
import { describe, expect, it } from "vitest";
import {
  ADAPTER_NAME,
  ADAPTER_TITLE,
  ADAPTER_VERSION,
  DEEPSEEK_HARNESS_VERSION,
  INITIALIZE_METADATA_KEY,
} from "../src/protocol.ts";
import { serveStdio, type RuntimeBoot, type SignalSource } from "../src/server.ts";
import { RUNTIME_READY_KEY } from "../src/runtime.ts";

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: number | string;
  result?: Record<string, unknown>;
  error?: { code: number; message: string };
}

interface ServerHarness {
  input: PassThrough;
  stdout: () => string;
  stderr: () => string;
  completion: Promise<void>;
}

function capture(args: { stream: PassThrough }): () => string {
  let content = "";
  args.stream.setEncoding("utf8");
  args.stream.on("data", (chunk: string) => {
    content += chunk;
  });
  return () => content;
}

function startHarness(args: { signalSource?: SignalSource } = {}): ServerHarness {
  const input = new PassThrough();
  const output = new PassThrough();
  const diagnostics = new PassThrough();
  return {
    input,
    stdout: capture({ stream: output }),
    stderr: capture({ stream: diagnostics }),
    completion: serveStdio({
      stateDir: "/synthetic-state",
      input,
      output,
      diagnostics,
      runtimeBoot: testRuntimeBoot,
      ...(args.signalSource === undefined ? {} : { signalSource: args.signalSource }),
    }),
  };
}

const testRuntimeBoot: RuntimeBoot = async (args) => {
  const context = new Context();
  const prepared = args.prepare(context);
  if (prepared !== undefined) await prepared;
  context.provide(RUNTIME_READY_KEY, true);
  return context;
};

function initializeRequest(args: {
  id: number | string;
  clientName?: string;
}): Record<string, unknown> {
  return {
    jsonrpc: "2.0",
    id: args.id,
    method: "initialize",
    params: {
      protocolVersion: PROTOCOL_VERSION,
      clientCapabilities: {},
      clientInfo: { name: args.clientName ?? "synthetic-client", version: "1.0.0" },
    },
  };
}

function writeMessage(args: { harness: ServerHarness; message: Record<string, unknown> }): void {
  args.harness.input.write(`${JSON.stringify(args.message)}\n`);
}

function responses(args: { harness: ServerHarness }): JsonRpcResponse[] {
  return args.harness
    .stdout()
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as JsonRpcResponse);
}

async function finish(args: { harness: ServerHarness }): Promise<void> {
  args.harness.input.end();
  await args.harness.completion;
}

describe("initialize-only ACP server", () => {
  it("frames responses, preserves request ids, and publishes exact metadata", async () => {
    const harness = startHarness();
    writeMessage({ harness, message: initializeRequest({ id: "request-a" }) });
    writeMessage({ harness, message: initializeRequest({ id: 42 }) });
    await expect.poll(() => responses({ harness }).length).toBe(2);

    const byId = new Map(responses({ harness }).map((response) => [response.id, response]));
    const result = byId.get("request-a")?.result;
    expect(byId.get(42)?.jsonrpc).toBe("2.0");
    expect(result).toMatchObject({
      protocolVersion: PROTOCOL_VERSION,
      agentCapabilities: { loadSession: false },
      agentInfo: { name: ADAPTER_NAME, title: ADAPTER_TITLE, version: ADAPTER_VERSION },
      authMethods: [],
      _meta: {
        [INITIALIZE_METADATA_KEY]: {
          extensionProtocolVersion: 1,
          adapterVersion: ADAPTER_VERSION,
          harnessVersion: DEEPSEEK_HARNESS_VERSION,
          persistenceOwner: "sesori",
        },
      },
    });
    expect(harness.stderr()).toBe("");
    await finish({ harness });
  });

  it("accepts CRLF, split UTF-8 chunks, and multiple records per chunk", async () => {
    const harness = startHarness();
    const first = JSON.stringify(initializeRequest({ id: "crlf", clientName: "synthetic-α" }));
    const second = JSON.stringify(initializeRequest({ id: "lf" }));
    const bytes = Buffer.from(`${first}\r\n${second}\n`);
    const unicodeStart = bytes.indexOf(Buffer.from("α"));
    harness.input.write(bytes.subarray(0, unicodeStart + 1));
    harness.input.write(bytes.subarray(unicodeStart + 1));
    await expect.poll(() => responses({ harness }).length).toBe(2);

    expect(responses({ harness }).map((response) => response.id)).toEqual(
      expect.arrayContaining(["crlf", "lf"]),
    );
    await finish({ harness });
  });

  it("returns method-not-found without logging request payloads", async () => {
    const sentinel = "SENTINEL_PRIVATE_PROMPT_91a4";
    const harness = startHarness();
    writeMessage({
      harness,
      message: {
        jsonrpc: "2.0",
        id: "unknown-request",
        method: "sesori.test/unknown",
        params: { prompt: sentinel },
      },
    });
    await expect.poll(() => responses({ harness }).length).toBe(1);

    expect(responses({ harness })[0]?.error?.code).toBe(-32601);
    expect(harness.stderr()).toContain("acp_sdk: Error handling request");
    expect(harness.stdout()).not.toContain(sentinel);
    expect(harness.stderr()).not.toContain(sentinel);
    await finish({ harness });
  });

  it("drops malformed frames without leaking them and continues serving", async () => {
    const sentinel = "SENTINEL_PRIVATE_FRAME_623b";
    const harness = startHarness();
    harness.input.write(`{"private":"${sentinel}"\n`);
    writeMessage({ harness, message: initializeRequest({ id: "after-malformed" }) });
    await expect.poll(() => responses({ harness }).length).toBe(1);

    expect(responses({ harness })[0]?.id).toBe("after-malformed");
    expect(harness.stderr()).toContain("acp_sdk: Failed to parse JSON message:");
    expect(harness.stderr()).not.toContain(sentinel);
    await finish({ harness });
  });

  it("closes cleanly on input EOF", async () => {
    const harness = startHarness();
    await finish({ harness });
    expect(harness.stdout()).toBe("");
    expect(harness.stderr()).toBe("");
  });

  it.each(["SIGINT", "SIGTERM"] as const)("closes cleanly on %s", async (signal) => {
    const emitter = new EventEmitter();
    const signalSource: SignalSource = {
      once: (event, listener) => emitter.once(event, listener),
      off: (event, listener) => emitter.off(event, listener),
    };
    const harness = startHarness({ signalSource });
    expect(emitter.listenerCount(signal)).toBe(1);

    emitter.emit(signal);
    await harness.completion;
    expect(emitter.listenerCount("SIGINT")).toBe(0);
    expect(emitter.listenerCount("SIGTERM")).toBe(0);
  });
});
