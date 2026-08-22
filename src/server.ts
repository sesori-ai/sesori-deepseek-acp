import { Readable, Writable } from "node:stream";
import {
  AgentSideConnection,
  ndJsonStream,
  type Stream,
} from "@agentclientprotocol/sdk";
import type { Context, Fiber } from "@deepseek-ai/cordis";
import { bootRuntime, RUNTIME_READY_KEY } from "./runtime.js";
import { DurableSessionAgent } from "./sessions.js";

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

export interface AcpServer {
  connection: AgentSideConnection;
  dispose(): Promise<void>;
}

export function startAcpServer(args: {
  stream: Stream;
  diagnostics: DiagnosticWriter;
  context: Context;
}): AcpServer {
  const restoreDiagnostics = installAcpDiagnosticSanitizer({ diagnostics: args.diagnostics });
  try {
    let agent: DurableSessionAgent | undefined;
    const connection = new AgentSideConnection((activeConnection) => {
      agent = new DurableSessionAgent({
        context: args.context,
        connection: activeConnection,
        diagnostics: args.diagnostics,
      });
      return agent;
    }, args.stream);
    void connection.closed.then(restoreDiagnostics, restoreDiagnostics);
    return {
      connection,
      dispose: () => agent?.dispose() ?? Promise.resolve(),
    };
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
  let server: AcpServer | undefined;
  const closeInput = (): void => {
    args.input.destroy();
    if (server === undefined) void context?.fiber.dispose();
  };
  signalSource.once("SIGINT", closeInput);
  signalSource.once("SIGTERM", closeInput);
  let connection: AgentSideConnection | undefined;
  let transportFiber: Fiber | undefined;
  let operationFailure: unknown;
  try {
    const runRuntime = args.runtimeBoot ?? bootRuntime;
    context = await runRuntime({
      stateDir: args.stateDir,
      prepare: (bootContext) => {
        context = bootContext;
        transportFiber = bootContext.inject(
          [RUNTIME_READY_KEY, "agents", "sessionPersistence"],
          (transportContext) => {
            server = startAcpServer({
              stream,
              diagnostics: args.diagnostics,
              context: transportContext,
            });
            connection = server.connection;
            const activeServer = server;
            const activeConnection = connection;
            transportContext.effect(
              () => async () => {
                args.input.destroy();
                await activeConnection.closed.catch(() => undefined);
                await activeServer.dispose();
              },
              "sesori.acp",
            );
            void activeConnection.closed
              .then(() => activeServer.dispose(), () => activeServer.dispose())
              .then(
                () => transportContext.root.fiber.dispose(),
                () => transportContext.root.fiber.dispose(),
              );
          },
        );
      },
    });
    await transportFiber?.await();
    if (connection === undefined) {
      if (!args.input.destroyed) throw new Error("ACP transport did not mount");
    } else {
      await connection.closed;
    }
  } catch (error) {
    operationFailure = error;
  }
  args.input.destroy();
  const failures: unknown[] = operationFailure === undefined ? [] : [operationFailure];
  try {
    await server?.dispose();
  } catch (error) {
    failures.push(error);
  }
  try {
    await context?.fiber.dispose();
  } catch (error) {
    failures.push(error);
  }
  signalSource.off("SIGINT", closeInput);
  signalSource.off("SIGTERM", closeInput);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) throw new AggregateError(failures, "ACP shutdown failed");
}
