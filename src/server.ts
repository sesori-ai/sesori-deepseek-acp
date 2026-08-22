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
import { createInitializeResponse } from "./protocol.js";

export interface DiagnosticWriter {
  write(message: string): unknown;
}

export interface SignalSource {
  once(signal: NodeJS.Signals, listener: () => void): unknown;
  off(signal: NodeJS.Signals, listener: () => void): unknown;
}

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
  input: Readable;
  output: Writable;
  diagnostics: DiagnosticWriter;
  signalSource?: SignalSource;
}): Promise<void> {
  const input = Readable.toWeb(args.input) as unknown as ReadableStream<Uint8Array>;
  const stream = ndJsonStream(Writable.toWeb(args.output), input);
  const connection = startAcpServer({ stream, diagnostics: args.diagnostics });
  const signalSource = args.signalSource ?? process;
  const closeInput = (): void => {
    args.input.destroy();
  };
  signalSource.once("SIGINT", closeInput);
  signalSource.once("SIGTERM", closeInput);
  try {
    await connection.closed;
  } finally {
    signalSource.off("SIGINT", closeInput);
    signalSource.off("SIGTERM", closeInput);
  }
}
