import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  AGENT_METHODS,
  RequestError,
  type Agent as AcpAgent,
  type AgentSideConnection,
  type AuthenticateRequest,
  type AuthenticateResponse,
  type CancelNotification,
  type CloseSessionRequest,
  type CloseSessionResponse,
  type InitializeRequest,
  type InitializeResponse,
  type ListSessionsRequest,
  type ListSessionsResponse,
  type LoadSessionRequest,
  type LoadSessionResponse,
  type NewSessionRequest,
  type NewSessionResponse,
  type PromptRequest,
  type PromptResponse,
  type SessionInfo,
  type SessionNotification,
} from "@agentclientprotocol/sdk";
import type { Context } from "@deepseek-ai/cordis";
import type { AgentHandle } from "@deepseek-ai/dsh-agent";
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import { foldSessionTitle } from "@deepseek-ai/dsh-session-title";
import { createInitializeResponse, INITIALIZE_METADATA_KEY } from "./protocol.js";
import { validateProtocolValue } from "./schema.js";

const LIST_PAGE_SIZE = 100;
const DEFAULT_HISTORY_MESSAGES = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;

interface SessionRecord {
  readonly handle: AgentHandle;
}

interface HistoryRequest {
  sessionId: string;
  beforeSeq?: number;
  maxMessages?: number;
}

interface HistoryResponse {
  updates: SessionNotification[];
  nextBeforeSeq?: number;
  hasMore: boolean;
}

interface ListCursor {
  createdAt: number;
  id: string;
}

function invalidParams(detail: string): RequestError {
  return RequestError.invalidParams(undefined, detail);
}

function internalError(detail: string): RequestError {
  return RequestError.internalError(undefined, detail);
}

function parseSessionId(value: string): SessionId {
  if (
    value.length === 0 ||
    value.length > MAX_SESSION_ID_LENGTH ||
    !/\S/u.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) as number;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw invalidParams("invalid session id");
  }
  return SessionId(value);
}

function validateSetup(args: {
  cwd: string;
  mcpServers: readonly unknown[];
  additionalDirectories?: readonly string[];
}): void {
  if (args.cwd.length > MAX_PATH_LENGTH || !isAbsolute(args.cwd)) {
    throw invalidParams("cwd must be an absolute bounded path");
  }
  if (args.mcpServers.length > 0) throw invalidParams("MCP servers are not supported");
  if ((args.additionalDirectories?.length ?? 0) > 0) {
    throw invalidParams("additional directories are not supported");
  }
}

function compareHeaders(left: SessionHeader, right: SessionHeader): number {
  return right.createdAt - left.createdAt || compareSessionIds(String(left.id), String(right.id));
}

function compareSessionIds(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left), Buffer.from(right));
}

function encodeCursor(header: SessionHeader): string {
  return Buffer.from(JSON.stringify({ createdAt: header.createdAt, id: String(header.id) })).toString(
    "base64url",
  );
}

function decodeCursor(value: string): ListCursor {
  if (value.length === 0 || value.length > MAX_CURSOR_LENGTH) {
    throw invalidParams("invalid session list cursor");
  }
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      Object.keys(parsed).length !== 2 ||
      !("createdAt" in parsed) ||
      !Number.isSafeInteger(parsed.createdAt) ||
      (parsed.createdAt as number) < 0 ||
      !("id" in parsed) ||
      typeof parsed.id !== "string" ||
      parsed.id.length === 0
    ) {
      throw new Error("invalid cursor shape");
    }
    return { createdAt: parsed.createdAt as number, id: parsed.id };
  } catch {
    throw invalidParams("invalid session list cursor");
  }
}

function afterCursor(header: SessionHeader, cursor: ListCursor): boolean {
  return (
    header.createdAt < cursor.createdAt ||
    (header.createdAt === cursor.createdAt && compareSessionIds(String(header.id), cursor.id) > 0)
  );
}

function headerMetadata(header: SessionHeader): Record<string, unknown> {
  return {
    createdAt: header.createdAt,
    ...(header.parentSession === undefined ? {} : { parentSessionId: String(header.parentSession) }),
    ...(header.origin === undefined ? {} : { origin: header.origin }),
    ...(header.delegationDepth === undefined ? {} : { delegationDepth: header.delegationDepth }),
    ...(header.agentPreset === undefined ? {} : { agentPreset: header.agentPreset }),
  };
}

function sessionInfo(args: {
  header: SessionHeader;
  events?: readonly SessionEvent[];
}): SessionInfo {
  if (args.header.cwd === undefined || !isAbsolute(args.header.cwd)) {
    throw internalError("persisted session has no valid working directory");
  }
  const title = args.events === undefined ? undefined : foldSessionTitle(args.events);
  const updatedAt = args.events?.at(-1)?.time ?? title?.updatedAt ?? args.header.createdAt;
  return {
    sessionId: String(args.header.id),
    cwd: args.header.cwd,
    updatedAt: new Date(updatedAt).toISOString(),
    ...(title === undefined ? {} : { title: title.title }),
    _meta: { [INITIALIZE_METADATA_KEY]: headerMetadata(args.header) },
  };
}

function historyRequest(params: Record<string, unknown>): HistoryRequest {
  const validation = validateProtocolValue({ definition: "historyRequest", value: params });
  if (!validation.valid) throw invalidParams("invalid DeepSeek history request");
  return params as unknown as HistoryRequest;
}

function messageBoundary(event: SessionEvent): boolean {
  return (
    isAppendSurfaceEvent(event) &&
    ((event.type === "user/message" && event.data.source.kind === "user") ||
      event.type === "assistant/message")
  );
}

function assertKnownEvents(events: readonly SessionEvent[]): void {
  const unknown = events.find(
    (event) => !KNOWN_SESSION_EVENT_TYPES.has(event.type) && event.ignorable !== true,
  );
  if (unknown !== undefined) {
    throw new Error("session history contains an unsupported required event");
  }
}

function historyPage(args: {
  events: readonly SessionEvent[];
  beforeSeq?: number;
  maxMessages: number;
}): { events: SessionEvent[]; nextBeforeSeq?: number; hasMore: boolean } {
  const eligible = args.events.filter((event) => args.beforeSeq === undefined || event.seq < args.beforeSeq);
  assertKnownEvents(eligible);
  const starts = eligible.flatMap((event, index) => (messageBoundary(event) ? [index] : []));
  if (starts.length === 0) return { events: [], hasMore: false };
  const selectedStartIndex = Math.max(0, starts.length - args.maxMessages);
  const firstEventIndex = starts[selectedStartIndex] as number;
  const hasMore = selectedStartIndex > 0;
  const selected = eligible.slice(firstEventIndex);
  if (!hasMore) return { events: selected, hasMore: false };
  return {
    events: selected,
    hasMore: true,
    nextBeforeSeq: eligible[firstEventIndex]!.seq,
  };
}

async function imageContent(args: {
  context: Context;
  attachment: unknown;
}): Promise<Extract<SessionNotification["update"], { sessionUpdate: "agent_message_chunk" }>["content"]> {
  const attachments = args.context.get("attachments") as
    | {
        readImage(ref: unknown): Promise<{
          data: Uint8Array;
          ref: { mediaType: string };
        }>;
      }
    | undefined;
  if (attachments === undefined) throw new Error("attachment store is unavailable");
  const image = await attachments.readImage(args.attachment);
  return {
    type: "image",
    data: Buffer.from(image.data).toString("base64"),
    mimeType: image.ref.mediaType,
  };
}

async function replayUpdates(args: {
  context: Context;
  sessionId: string;
  events: readonly SessionEvent[];
}): Promise<SessionNotification[]> {
  assertKnownEvents(args.events);
  const updates: SessionNotification[] = [];
  for (const event of args.events) {
    if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) {
      continue;
    }
    if (event.type === "user/message" && isAppendSurfaceEvent(event)) {
      if (event.data.source.kind !== "user") continue;
      for (const block of event.data.content) {
        if (block.type !== "text" && block.type !== "image") {
          throw new Error("session history contains unsupported user content");
        }
        const content =
          block.type === "text"
            ? ({ type: "text", text: block.text } as const)
            : await imageContent({ context: args.context, attachment: block.attachment });
        updates.push({
          sessionId: args.sessionId,
          update: {
            sessionUpdate: "user_message_chunk",
            messageId: String(event.data.id),
            content,
          },
        });
      }
      continue;
    }
    if (event.type === "assistant/message" && isAppendSurfaceEvent(event)) {
      for (const block of event.data.message.content) {
        if (block.type === "tool-call") continue;
        if (block.type === "tool-result") {
          throw new Error("session history contains unsupported assistant tool-result content");
        }
        const content =
          block.type === "image"
            ? await imageContent({ context: args.context, attachment: block.attachment })
            : ({ type: "text", text: block.text } as const);
        updates.push({
          sessionId: args.sessionId,
          update: {
            sessionUpdate:
              block.type === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
            messageId: String(event.data.message.id),
            content,
          },
        });
      }
      continue;
    }
    if (event.type === "tool/call") {
      updates.push({
        sessionId: args.sessionId,
        update: {
          sessionUpdate: "tool_call",
          toolCallId: String(event.data.callId),
          title: event.data.name,
          status: "in_progress",
        },
      });
      continue;
    }
    if (event.type === "tool/result" && isAppendSurfaceEvent(event)) {
      const result = event.data.message.content[0];
      updates.push({
        sessionId: args.sessionId,
        update: {
          sessionUpdate: "tool_call_update",
          toolCallId: String(result.toolCallId),
          status: event.data.error === undefined && result.isError !== true ? "completed" : "failed",
        },
      });
    }
  }
  return updates;
}

export class DurableSessionAgent implements AcpAgent {
  readonly #context: Context;
  readonly #connection: AgentSideConnection;
  readonly #diagnostics: { write(message: string): unknown };
  readonly #sessions = new Map<SessionId, SessionRecord>();
  readonly #creations = new Set<Promise<void>>();
  readonly #loads = new Map<SessionId, Promise<void>>();
  readonly #closes = new Map<SessionId, Promise<CloseSessionResponse>>();
  #closed = false;
  #disposal: Promise<void> | undefined;

  constructor(args: {
    context: Context;
    connection: AgentSideConnection;
    diagnostics: { write(message: string): unknown };
  }) {
    this.#context = args.context;
    this.#connection = args.connection;
    this.#diagnostics = args.diagnostics;
  }

  async initialize(_params: InitializeRequest): Promise<InitializeResponse> {
    return createInitializeResponse();
  }

  async authenticate(_params: AuthenticateRequest): Promise<AuthenticateResponse> {
    return {};
  }

  async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
    this.#assertOpen();
    if (
      params.cwd !== undefined &&
      params.cwd !== null &&
      (params.cwd.length > MAX_PATH_LENGTH || !isAbsolute(params.cwd))
    ) {
      throw invalidParams("cwd filter must be an absolute bounded path");
    }
    const cursor = params.cursor === undefined || params.cursor === null ? undefined : decodeCursor(params.cursor);
    try {
      const headers = await this.#context.sessionPersistence.list();
      const ids = new Set<string>();
      for (const header of headers) {
        const id = String(header.id);
        if (ids.has(id)) throw new Error("duplicate persisted session id");
        ids.add(id);
      }
      const filtered = headers
        .filter((header) => params.cwd === undefined || params.cwd === null || header.cwd === params.cwd)
        .sort(compareHeaders)
        .filter((header) => cursor === undefined || afterCursor(header, cursor));
      const page = filtered.slice(0, LIST_PAGE_SIZE);
      return {
        sessions: page.map((header) => sessionInfo({ header })),
        ...(filtered.length > LIST_PAGE_SIZE && page.at(-1) !== undefined
          ? { nextCursor: encodeCursor(page.at(-1) as SessionHeader) }
          : {}),
      };
    } catch (error) {
      this.#diagnose("session/list", undefined, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to list DeepSeek sessions");
    }
  }

  async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
    this.#assertOpen();
    validateSetup(params);
    const sessionId = SessionId(randomUUID());
    const creationDone = Promise.withResolvers<void>();
    void creationDone.promise.catch(() => undefined);
    this.#creations.add(creationDone.promise);
    let handle: AgentHandle | undefined;
    let cleanupFailure: unknown;
    try {
      handle = await this.#context.agents.create({ sessionId, meta: { cwd: params.cwd } });
      if (this.#closed) throw new Error("adapter disposed during session creation");
      if (handle.agent.session.id !== sessionId || this.#sessions.has(sessionId)) {
        throw new Error("agent factory returned a duplicate or mismatched session id");
      }
      this.#sessions.set(sessionId, { handle });
      return { sessionId: String(sessionId), configOptions: [] };
    } catch (error) {
      await handle?.dispose().catch((disposeError: unknown) => {
        cleanupFailure = disposeError;
        this.#diagnose("session/new cleanup", sessionId, disposeError);
      });
      this.#diagnose("session/new", sessionId, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to create DeepSeek session");
    } finally {
      this.#creations.delete(creationDone.promise);
      if (cleanupFailure === undefined) creationDone.resolve();
      else creationDone.reject(cleanupFailure);
    }
  }

  async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
    this.#assertOpen();
    validateSetup(params);
    const sessionId = parseSessionId(params.sessionId);
    const closing = this.#closes.get(sessionId);
    if (closing !== undefined) {
      await closing;
      this.#assertOpen();
    }
    if (this.#loads.has(sessionId)) throw invalidParams("session load is already in progress");
    const loadDone = Promise.withResolvers<void>();
    this.#loads.set(sessionId, loadDone.promise);
    let adopted = false;
    let resumed = false;
    let handle: AgentHandle | undefined;
    try {
      const inspection = await this.#inspect(sessionId);
      if (inspection.meta.cwd !== params.cwd) {
        throw invalidParams("cwd does not match persisted session");
      }
      const updates = await replayUpdates({
        context: this.#context,
        sessionId: String(sessionId),
        events: inspection.events,
      });
      const resident = this.#sessions.get(sessionId);
      if (resident !== undefined) {
        if (this.#context.agents.get(sessionId) !== resident.handle.agent) {
          throw new Error("owned session is no longer registered");
        }
        handle = resident.handle;
      } else {
        if (this.#context.agents.get(sessionId) !== undefined) {
          throw new Error("session is already owned outside this ACP connection");
        }
        handle = await this.#context.agents.resume({ resumeSessionId: sessionId });
        resumed = true;
        if (this.#closed || this.#sessions.has(sessionId)) {
          throw new Error("adapter ownership changed during session load");
        }
        this.#sessions.set(sessionId, { handle });
        adopted = true;
      }
      for (const update of updates) await this.#connection.sessionUpdate(update);
      return { configOptions: [] };
    } catch (error) {
      if ((adopted || resumed) && handle !== undefined) {
        if (adopted) this.#sessions.delete(sessionId);
        await handle.dispose().catch((disposeError: unknown) => {
          this.#diagnose("session/load cleanup", sessionId, disposeError);
        });
      }
      this.#diagnose("session/load", sessionId, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to load DeepSeek session");
    } finally {
      this.#loads.delete(sessionId);
      loadDone.resolve();
    }
  }

  closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
    this.#assertOpen();
    const sessionId = parseSessionId(params.sessionId);
    const existing = this.#closes.get(sessionId);
    if (existing !== undefined) return existing;
    const closing = this.#closeSession(sessionId);
    this.#closes.set(sessionId, closing);
    void closing.then(
      () => this.#closes.delete(sessionId),
      () => this.#closes.delete(sessionId),
    );
    return closing;
  }

  async #closeSession(sessionId: SessionId): Promise<CloseSessionResponse> {
    const loading = this.#loads.get(sessionId);
    if (loading !== undefined) await loading;
    const record = this.#sessions.get(sessionId);
    if (record === undefined) return {};
    this.#sessions.delete(sessionId);
    try {
      await record.handle.dispose();
      return {};
    } catch (error) {
      if (!this.#closed && !this.#sessions.has(sessionId)) {
        this.#sessions.set(sessionId, record);
      }
      this.#diagnose("session/close", sessionId, error);
      throw internalError("unable to close DeepSeek session");
    }
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (method !== "deepseek/session/history") throw RequestError.methodNotFound(method);
    this.#assertOpen();
    const request = historyRequest(params);
    const sessionId = parseSessionId(request.sessionId);
    try {
      const inspection = await this.#inspect(sessionId);
      const page = historyPage({
        events: inspection.events,
        maxMessages: request.maxMessages ?? DEFAULT_HISTORY_MESSAGES,
        ...(request.beforeSeq === undefined ? {} : { beforeSeq: request.beforeSeq }),
      });
      const response: HistoryResponse = {
        updates: await replayUpdates({
          context: this.#context,
          sessionId: request.sessionId,
          events: page.events,
        }),
        hasMore: page.hasMore,
        ...(page.nextBeforeSeq === undefined ? {} : { nextBeforeSeq: page.nextBeforeSeq }),
      };
      if (!validateProtocolValue({ definition: "historyResponse", value: response }).valid) {
        throw new Error("DeepSeek history response exceeds protocol bounds");
      }
      return response as unknown as Record<string, unknown>;
    } catch (error) {
      this.#diagnose("deepseek/session/history", sessionId, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to read DeepSeek session history");
    }
  }

  async prompt(_params: PromptRequest): Promise<PromptResponse> {
    throw RequestError.methodNotFound(AGENT_METHODS.session_prompt);
  }

  async cancel(_params: CancelNotification): Promise<void> {}

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  async #inspect(sessionId: SessionId): Promise<SessionInspection> {
    const resident = this.#sessions.get(sessionId);
    if (resident !== undefined) {
      return { meta: resident.handle.agent.session.header, events: resident.handle.agent.session.events };
    }
    const headers = await this.#context.sessionPersistence.list();
    if (!headers.some((header) => header.id === sessionId)) throw invalidParams("unknown session");
    return this.#context.sessionPersistence.inspect(sessionId);
  }

  #assertOpen(): void {
    if (this.#closed) throw internalError("the ACP session owner has been disposed");
  }

  #diagnose(operation: string, sessionId: SessionId | undefined, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.#diagnostics.write(
      `sesori-deepseek-acp: ${operation}${sessionId === undefined ? "" : ` session=${sessionId}`}: ${detail}\n`,
    );
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    const transitionOutcomes = await Promise.allSettled([
      ...this.#creations,
      ...this.#loads.values(),
      ...this.#closes.values(),
    ]);
    const records = [...this.#sessions.values()];
    this.#sessions.clear();
    const outcomes = await Promise.allSettled(records.map((record) => record.handle.dispose()));
    const failures = [...transitionOutcomes, ...outcomes].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "failed to dispose DeepSeek sessions");
  }
}
