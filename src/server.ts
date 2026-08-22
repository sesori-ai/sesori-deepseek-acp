import { Readable, Writable } from "node:stream";
import {
  AGENT_METHODS,
  AgentSideConnection,
  RequestError,
  ndJsonStream,
  type Agent,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type InitializeRequest,
  type InitializeResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { Context, Fiber } from "@deepseek-ai/cordis";
import { createInitializeResponse } from "./protocol.js";
import { bootRuntime, RUNTIME_READY_KEY } from "./runtime.js";

export interface DiagnosticWriter {
  write(message: string): unknown;
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

export type RuntimeBoot = (args: {
  stateDir: string;
  prepare: (context: Context) => Promise<void> | void;
}) => Promise<Context>;

const AcpSdkDiagnostic = {
  ErrorNotification: "Error handling notification",
  ErrorRequest: "Error handling request",
  InvalidMessage: "Invalid message",
  MalformedJson: "Failed to parse JSON message:",
  UnexpectedMessageError: "Unexpected error during message processing:",
  UnknownResponse: "Got response to unknown request",
} as const;

const acpSdkDiagnostics = new Set<string>(Object.values(AcpSdkDiagnostic));

function installAcpDiagnosticSanitizer(args: { diagnostics: DiagnosticWriter }): () => void {
  const original = console.error;
  const sanitized = (...values: unknown[]): void => {
    const category = values[0];
    if (typeof category === "string" && acpSdkDiagnostics.has(category)) {
      args.diagnostics.write(`sesori-deepseek-acp: acp_sdk: ${category}\n`);
      return;
    }
    original(...values);
  };
  console.error = sanitized;
  return () => {
    if (console.error === sanitized) console.error = original;
  };
}

class InitializeOnlyAgent implements Agent {
  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return createInitializeResponse();
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async newSession(_params: NewSessionRequest): Promise<NewSessionResponse> {
    throw RequestError.methodNotFound(AGENT_METHODS.session_new);
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    throw RequestError.methodNotFound(AGENT_METHODS.session_prompt);
  }

  async cancel(_params: CancelNotification): Promise<void> {}
}

export function startAcpServer(args: {
  stream: Stream;
  diagnostics: DiagnosticWriter;
}): AgentSideConnection {
  const restoreDiagnostics = installAcpDiagnosticSanitizer({ diagnostics: args.diagnostics });
  try {
    const connection = new AgentSideConnection(() => new InitializeOnlyAgent(), args.stream);
    void connection.closed.then(restoreDiagnostics, restoreDiagnostics);
    return connection;
  } catch (error) {
    restoreDiagnostics();
    throw error;
  }
}

export async function serveStdio(args: {
  stateDir: string;
  input: Readable;
  output: Writable;
  diagnostics: DiagnosticWriter;
  signalSource?: SignalSource;
  runtimeBoot?: RuntimeBoot;
}): Promise<void> {
  const input = Readable.toWeb(args.input) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(Writable.toWeb(args.output), input);
  const signalSource = args.signalSource ?? process;
  let context: Context | undefined;
  const closeInput = (): void => {
    args.input.destroy();
    void context?.fiber.dispose();
  };
  signalSource.once("SIGINT", closeInput);
  signalSource.once("SIGTERM", closeInput);
  let connection: AgentSideConnection | undefined;
  let transportFiber: Fiber | undefined;
  try {
    const runRuntime = args.runtimeBoot ?? bootRuntime;
    context = await runRuntime({
      stateDir: args.stateDir,
      prepare: (bootContext) => {
        context = bootContext;
        transportFiber = bootContext.inject([RUNTIME_READY_KEY], (transportContext) => {
          connection = startAcpServer({ stream, diagnostics: args.diagnostics });
          const activeConnection = connection;
          transportContext.effect(
            () => async () => {
              args.input.destroy();
              await activeConnection.closed.catch(() => undefined);
            },
            "sesori.acp",
          );
          void activeConnection.closed.then(
            () => transportContext.root.fiber.dispose(),
            () => transportContext.root.fiber.dispose(),
          );
        });
      },
    });
    await transportFiber?.await();
    if (connection === undefined) {
      if (args.input.destroyed) return;
      throw new Error("ACP transport did not mount");
    }
    await connection.closed;
  } finally {
    args.input.destroy();
    await context?.fiber.dispose();
    signalSource.off("SIGINT", closeInput);
    signalSource.off("SIGTERM", closeInput);
  }
}
