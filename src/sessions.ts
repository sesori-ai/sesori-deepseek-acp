import { createHash, randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
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
  type SessionConfigOption,
  type SessionNotification,
  type SetSessionConfigOptionRequest,
  type SetSessionConfigOptionResponse,
  type StopReason,
  type ToolCallContent,
} from "@agentclientprotocol/sdk";
import type { Context } from "@deepseek-ai/cordis";
import type { Agent, AgentHandle } from "@deepseek-ai/dsh-agent";
import type {} from "@deepseek-ai/dsh-agent-default-model";
import { isImageAdmissionError, type EncodedImageAttachment } from "@deepseek-ai/dsh-attachment";
import { parseCommand } from "@deepseek-ai/dsh-commands";
import type {} from "@deepseek-ai/dsh-commands/types";
import { freezeMessage, MessageId, ReasoningEffortId, type ContentBlock, type LlmCallConfig, type ReasoningEffortId as ReasoningEffort, type TokenUsage, type UserMessage } from "@deepseek-ai/dsh-llm";
import type { ApprovalOutcome, ApprovalRequest } from "@deepseek-ai/dsh-user-approval";
import type {} from "@deepseek-ai/dsh-llm-retry/types";
import type {} from "@deepseek-ai/dsh-compaction/types";
import {
  KNOWN_SESSION_EVENT_TYPES,
  SessionId,
  type SessionEvent,
  type SessionHeader,
} from "@deepseek-ai/dsh-session";
import { isAppendSurfaceEvent } from "@deepseek-ai/dsh-session/surface";
import type { SessionInspection } from "@deepseek-ai/dsh-session-persistence";
import { foldSessionTitle, SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";
import { createInitializeResponse, INITIALIZE_METADATA_KEY } from "./protocol.js";
import { validateProtocolValue } from "./schema.js";

const LIST_PAGE_SIZE = 100;
const DEFAULT_HISTORY_MESSAGES = 50;
const MAX_CURSOR_LENGTH = 512;
const MAX_PATH_LENGTH = 4096;
const MAX_SESSION_ID_LENGTH = 256;
const MAX_MESSAGE_ID_LENGTH = 256;
const PROMPT_METADATA_KEY = "sesori.ai/deepseek";
const MODEL_CONFIG_ID = "deepseek.model";
const REASONING_CONFIG_ID = "deepseek.reasoning_effort";

interface CatalogModel {
  id: string;
  upstreamModelId: string;
  name: string;
  reasoningEfforts: string[];
  defaultReasoningEffort: string | null;
  supportsImages: boolean;
}

interface ModelSelection {
  provider: string;
  model: string;
  reasoningEffort?: ReasoningEffort;
}

interface ModelSelectionRef {
  current: ModelSelection | undefined;
  assembled: ModelSelection | undefined;
}

function installSelection(agentContext: Context, selection: ModelSelectionRef): void {
  agentContext.on("system-prompt/assemble", async (_assembly, _context, next) => {
    const selected = selection.current;
    const assembled = await next();
    selection.assembled = selected;
    if (selected === undefined) return assembled;
    return {
      ...assembled,
      variables: { ...assembled.variables, provider: selected.provider, model: selected.model },
    };
  });
  agentContext.on("agent/request", async (_payload, next): Promise<LlmCallConfig> => {
    const resolved = await next();
    const selected = selection.assembled;
    if (selected === undefined) return resolved;
    const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
    return {
      ...rest,
      provider: selected.provider,
      model: selected.model,
      ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
    };
  });
}

interface CatalogResponse {
  agent: { id: "deepseek"; name: "DeepSeek"; primary: true };
  providers: { id: string; name: string; models: CatalogModel[] }[];
  defaultSelectionId: string | null;
  commands: { name: string; description: string }[];
  failures: { providerId: string; category: string; message: string }[];
}

function assistantMessageId(sessionId: string, turn: number, step: number): string {
  return `deepseek-assistant-${createHash("sha256").update(`${sessionId}\0${turn}\0${step}`).digest("base64url").slice(0, 24)}`;
}

function commandMessageId(sessionId: string, commandId: string): string {
  return `deepseek-command-${createHash("sha256").update(`${sessionId}\0${commandId}`).digest("base64url").slice(0, 24)}`;
}

function promptMessageId(params: PromptRequest): string {
  const metadata = params._meta?.[PROMPT_METADATA_KEY];
  const value =
    typeof metadata === "object" && metadata !== null && "messageId" in metadata
      ? metadata.messageId
      : undefined;
  if (value === undefined) return randomUUID();
  if (
    typeof value !== "string" ||
    value.length > MAX_MESSAGE_ID_LENGTH ||
    !/\S/u.test(value) ||
    [...value].some((character) => {
      const code = character.codePointAt(0) as number;
      return code <= 0x1f || (code >= 0x7f && code <= 0x9f);
    })
  ) {
    throw invalidParams("invalid DeepSeek prompt message id");
  }
  return value;
}

interface InflightPrompt {
  readonly completion: PromiseWithResolvers<StopReason>;
  readonly admission: PromiseWithResolvers<void>;
  readonly terminal: PromiseWithResolvers<void>;
  readonly controller: AbortController;
  messageId?: string;
  turn?: number;
  endReason?: unknown;
  queued: boolean;
  cancelled: boolean;
  settling: boolean;
  command: boolean;
  outputError?: unknown;
  agentError?: unknown;
  readonly usageByStep: Map<number, TokenUsage>;
}

interface SessionRecord {
  readonly handle: AgentHandle;
  readonly selection: ModelSelectionRef;
  readonly toolCalls: Map<string, { name: string; arguments: string }>;
  outputTail: Promise<void>;
  inflight: InflightPrompt | undefined;
}

function selectionId(selection: Pick<ModelSelection, "provider" | "model">): string {
  return `v1${Buffer.from(JSON.stringify([selection.provider, selection.model])).toString("base64url")}`;
}

function decodeSelectionId(value: string): Pick<ModelSelection, "provider" | "model"> | undefined {
  if (!value.startsWith("v1")) return undefined;
  try {
    const decoded: unknown = JSON.parse(Buffer.from(value.slice(2), "base64url").toString("utf8"));
    if (
      !Array.isArray(decoded) ||
      decoded.length !== 2 ||
      decoded.some((item) => typeof item !== "string" || item.length === 0)
    ) {
      return undefined;
    }
    const selection = { provider: decoded[0] as string, model: decoded[1] as string };
    return selectionId(selection) === value ? selection : undefined;
  } catch {
    return undefined;
  }
}

function commandPrompt(prompt: PromptRequest["prompt"]): { line: string; images: EncodedImageAttachment[] } | undefined {
  let line: string | undefined;
  const images: EncodedImageAttachment[] = [];
  for (const block of prompt) {
    if (block.type === "text" && line === undefined) line = block.text;
    else if (block.type === "image") {
      images.push({ mediaType: block.mimeType as EncodedImageAttachment["mediaType"], data: block.data });
    } else return undefined;
  }
  return line === undefined || parseCommand(line) === undefined ? undefined : { line, images };
}

function promptUsage(usages: Iterable<TokenUsage>): PromptResponse["usage"] {
  let inputTokens = 0;
  let outputTokens = 0;
  let cachedReadTokens = 0;
  let cachedWriteTokens = 0;
  let thoughtTokens = 0;
  for (const usage of usages) {
    inputTokens += usage.inputTokens;
    outputTokens += usage.outputTokens;
    cachedReadTokens += usage.cacheReadTokens ?? 0;
    cachedWriteTokens += usage.cacheWriteTokens ?? 0;
    thoughtTokens += usage.reasoningTokens ?? 0;
  }
  const totalTokens = inputTokens + outputTokens + cachedReadTokens + cachedWriteTokens;
  if (totalTokens === 0) return undefined;
  return {
    inputTokens,
    outputTokens,
    totalTokens,
    ...(cachedReadTokens === 0 ? {} : { cachedReadTokens }),
    ...(cachedWriteTokens === 0 ? {} : { cachedWriteTokens }),
    ...(thoughtTokens === 0 ? {} : { thoughtTokens }),
  };
}

async function withAbort<T>(promise: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return promise;
  signal.throwIfAborted();
  let rejectAborted: (reason: unknown) => void = () => undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    rejectAborted = reject;
  });
  const onAbort = (): void => rejectAborted(signal.reason);
  signal.addEventListener("abort", onAbort, { once: true });
  try {
    return await Promise.race([promise, aborted]);
  } finally {
    signal.removeEventListener("abort", onAbort);
  }
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

class ToolArgumentsParseError extends Error {
  constructor(cause: unknown) {
    super("tool arguments are not valid JSON", { cause });
  }
}

function parseToolArguments(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new ToolArgumentsParseError(error);
  }
}

function toolPresentationError(error: unknown, message: string): Error {
  return error instanceof ToolArgumentsParseError ? error : new Error(message, { cause: error });
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

async function admitPrompt(args: {
  context: Context;
  prompt: PromptRequest["prompt"];
  signal: AbortSignal;
}): Promise<UserMessage["content"]> {
  const images = args.prompt.filter((block) => block.type === "image");
  const attachments = args.context.get("attachments") as
    | { saveImages(inputs: readonly { data: Uint8Array; mediaType: string }[]): Promise<readonly unknown[]> }
    | undefined;
  if (images.length > 0 && attachments === undefined) throw invalidParams("image prompts are unavailable");
  const inputs = images.map((image) => {
    if (image.uri !== undefined && image.uri !== null) throw invalidParams("image URLs are not supported");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) {
      throw invalidParams("unsupported image media type");
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)) {
      throw invalidParams("invalid image base64");
    }
    return { data: Buffer.from(image.data, "base64"), mediaType: image.mimeType };
  });
  args.signal.throwIfAborted();
  const refs = inputs.length === 0 ? [] : await withAbort(attachments!.saveImages(inputs), args.signal);
  args.signal.throwIfAborted();
  let imageIndex = 0;
  return args.prompt.map((block) => {
    if (block.type === "text") return { type: "text", text: block.text };
    if (block.type === "image") return { type: "image", attachment: refs[imageIndex++] };
    throw invalidParams("unsupported prompt content");
  }) as UserMessage["content"];
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

async function toolContent(args: {
  context: Context;
  blocks: readonly ContentBlock[];
}): Promise<ToolCallContent[]> {
  const content: ToolCallContent[] = [];
  for (const block of args.blocks) {
    if (block.type === "text" || block.type === "reasoning") {
      content.push({ type: "content", content: { type: "text", text: block.text } });
    } else if (block.type === "image") {
      content.push({
        type: "content",
        content: await imageContent({ context: args.context, attachment: block.attachment }),
      });
    }
  }
  return content;
}

interface EventProjection {
  context: Context;
  sessionId: string;
  agent?: Agent;
  mode: "live" | "replay";
  toolCalls: Map<string, { name: string; arguments: string }>;
  emitUpdate(update: SessionNotification["update"]): Promise<void>;
  emitStatus?(status: Record<string, unknown>): Promise<void>;
  diagnose(operation: string, error: unknown): void;
  onUsage?(turn: number, step: number, usage: TokenUsage): void;
  onTurnEnd?(turn: number, reason: unknown): void;
}

async function projectSessionEvent(args: EventProjection, event: SessionEvent): Promise<void> {
  if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) return;
  if (event.type === "user/message" && isAppendSurfaceEvent(event)) {
    if (args.mode === "live" || event.data.source.kind !== "user") return;
    for (const block of event.data.content) {
      if (block.type !== "text" && block.type !== "image") {
        throw new Error("session history contains unsupported user content");
      }
      await args.emitUpdate({
        sessionUpdate: "user_message_chunk",
        messageId: String(event.data.id),
        content:
          block.type === "text"
            ? { type: "text", text: block.text }
            : await imageContent({ context: args.context, attachment: block.attachment }),
      });
    }
    return;
  }
  if (event.type === "assistant/chunk" && args.mode === "live") {
    const chunk = event.data.chunk;
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      await args.emitUpdate({
        sessionUpdate: chunk.type === "reasoning-delta" ? "agent_thought_chunk" : "agent_message_chunk",
        messageId: assistantMessageId(args.sessionId, event.data.turn, event.data.step),
        content: { type: "text", text: chunk.text },
      });
    } else if (chunk.type === "usage") {
      args.onUsage?.(event.data.turn, event.data.step, chunk.usage);
    }
    return;
  }
  if (event.type === "assistant/message" && isAppendSurfaceEvent(event)) {
    if (event.data.usage !== undefined) {
      args.onUsage?.(event.data.turn, event.data.step, event.data.usage);
    }
    for (const block of event.data.message.content) {
      if (block.type === "tool-call") continue;
      if (block.type === "tool-result") {
        throw new Error("session history contains unsupported assistant tool-result content");
      }
      if (args.mode === "live" && block.type !== "image") continue;
      await args.emitUpdate({
        sessionUpdate: block.type === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
        messageId: assistantMessageId(args.sessionId, event.data.turn, event.data.step),
        content:
          block.type === "image"
            ? await imageContent({ context: args.context, attachment: block.attachment })
            : { type: "text", text: block.text },
      });
    }
    return;
  }
  if (event.type === "tool/call") {
    const callId = String(event.data.callId);
    args.toolCalls.set(callId, { name: event.data.name, arguments: event.data.arguments });
    const update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }> = {
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title: event.data.name,
      status: "in_progress",
    };
    try {
      const tools = args.context.get("tools") as
        | { get(name: string, agent?: Agent): { presentCall?(value: unknown): unknown } | undefined }
        | undefined;
      const view = tools?.get(event.data.name, args.agent)?.presentCall?.(parseToolArguments(event.data.arguments)) as
        | {
            card: string;
            title: string;
            kind?: typeof update.kind;
            rawInput?: unknown;
            content?: ContentBlock[];
            locations?: { path: string; line?: number }[];
            diffs?: { path: string; oldText: string | null; newText: string }[];
          }
        | undefined;
      if (view !== undefined) {
        update.title = view.title;
        if (view.card === "diff") {
          update.kind = "edit";
          update.content = (view.diffs ?? []).map((diff) => ({ type: "diff", ...diff }));
        } else if (view.card === "terminal") {
          update.kind = "execute";
        } else {
          update.kind = view.kind ?? "other";
          if (view.rawInput !== undefined) update.rawInput = view.rawInput;
          if (view.content !== undefined) {
            update.content = await toolContent({ context: args.context, blocks: view.content });
          }
        }
        if (view.locations !== undefined) update.locations = view.locations;
      }
    } catch (error) {
      args.diagnose("tool/call presentation", toolPresentationError(error, "tool call presenter failed"));
    }
    await args.emitUpdate(update);
    return;
  }
  if (event.type === "tool/result" && isAppendSurfaceEvent(event)) {
    const result = event.data.message.content[0];
    const callId = String(result.toolCallId);
    const update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call_update" }> = {
      sessionUpdate: "tool_call_update",
      toolCallId: callId,
      status: event.data.error === undefined && result.isError !== true ? "completed" : "failed",
    };
    const call = args.toolCalls.get(callId);
    args.toolCalls.delete(callId);
    if (call !== undefined) {
      try {
        const tools = args.context.get("tools") as
          | {
              get(name: string, agent?: Agent):
                | { presentResult?(value: unknown, result: unknown): unknown }
                | undefined;
            }
          | undefined;
        const view = tools?.get(call.name, args.agent)?.presentResult?.(parseToolArguments(call.arguments), {
          content: result.content,
          isError: result.isError === true,
          ...(event.data.meta === undefined ? {} : { meta: event.data.meta }),
        }) as
          | {
              card: string;
              title?: string;
              content?: ContentBlock[];
              output?: string;
              diffs?: { path: string; oldText: string | null; newText: string }[];
            }
          | undefined;
        if (view?.title !== undefined) update.title = view.title;
        if (view?.card === "diff") {
          update.content = (view.diffs ?? []).map((diff) => ({ type: "diff", ...diff }));
        } else if (view?.card === "terminal" && view.output !== undefined) {
          update.content = [{ type: "content", content: { type: "text", text: view.output } }];
        } else if (view?.content !== undefined) {
          update.content = await toolContent({ context: args.context, blocks: view.content });
        }
      } catch (error) {
        args.diagnose("tool/result presentation", toolPresentationError(error, "tool result presenter failed"));
      }
    }
    await args.emitUpdate(update);
    return;
  }
  if (event.type === "command/done" && event.data.text !== undefined) {
    await args.emitUpdate({
      sessionUpdate: "agent_message_chunk",
      messageId: commandMessageId(args.sessionId, String(event.data.commandId)),
      content: { type: "text", text: event.data.text },
    });
    return;
  }
  if (event.type === "todo/write") {
    await args.emitUpdate({
      sessionUpdate: "plan",
      entries: event.data.todos.map((item) => ({
        content: item.content,
        status: item.status,
        priority: "medium",
      })),
    });
    return;
  }
  if (event.type === "session/title") {
    await args.emitUpdate({ sessionUpdate: "session_info_update", title: event.data.title });
    return;
  }
  if (event.type === "turn/end" && args.mode === "live") {
    args.onTurnEnd?.(event.data.turn, event.data.reason);
    return;
  }
  if (event.type === "llm/retry" && args.mode === "live") {
    const status = {
      sessionId: args.sessionId,
      kind: "retry",
      attempt: event.data.retry,
      ...("maxRetries" in event.data ? { limit: event.data.maxRetries } : {}),
    };
    if (validateProtocolValue({ definition: "sessionStatusNotification", value: status }).valid) {
      await args.emitStatus?.(status);
    }
    return;
  }
  if ((event.type === "compaction/start" || event.type === "compaction/end") && args.mode === "live") {
    const status =
      event.type === "compaction/end" && event.data.error !== undefined
        ? { sessionId: args.sessionId, kind: "warning", message: "DeepSeek compaction failed" }
        : {
            sessionId: args.sessionId,
            kind: event.type === "compaction/start" ? "compaction_started" : "compaction_completed",
          };
    await args.emitStatus?.(status);
  }
}

async function replayUpdates(args: {
  context: Context;
  sessionId: string;
  events: readonly SessionEvent[];
  diagnose: (operation: string, error: unknown) => void;
}): Promise<SessionNotification[]> {
  assertKnownEvents(args.events);
  const updates: SessionNotification[] = [];
  const projection: EventProjection = {
    context: args.context,
    sessionId: args.sessionId,
    mode: "replay",
    toolCalls: new Map(),
    emitUpdate: (update) => {
      updates.push({ sessionId: args.sessionId, update });
      return Promise.resolve();
    },
    diagnose: args.diagnose,
  };
  for (const event of args.events) await projectSessionEvent(projection, event);
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
  readonly #hooks: (() => void)[] = [];
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
    this.#hooks.push(this.#context.on("session/event", (session, event: SessionEvent) => {
      const record = this.#sessions.get(session.id);
      if (record?.handle.agent.session !== session) return;
      this.#projectEvent(record, event);
    }));
    this.#hooks.push(this.#context.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      const inflight = this.#ownedRecord(agent)?.inflight;
      if (inflight?.messageId === String(message.id)) inflight.turn = turn;
    }));
    this.#hooks.push(this.#context.on("agent/error", ({ agent, turn, error }) => {
      const record = this.#ownedRecord(agent);
      const inflight = record?.inflight;
      if (record === undefined || inflight === undefined || !inflight.queued || (!inflight.command && inflight.turn !== turn)) return;
      inflight.agentError = error;
      inflight.terminal.resolve();
      this.#settle(record, inflight);
    }));
    this.#hooks.push(this.#context.on("commands/change", () => {
      for (const record of this.#sessions.values()) {
        this.#queue(record, () =>
          this.#connection.sessionUpdate({
            sessionId: String(record.handle.agent.id),
            update: { sessionUpdate: "available_commands_update", availableCommands: this.#commands(record.handle.agent) },
          }),
        );
      }
    }));
    this.#hooks.push(this.#context.on("approval/request", (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      const record = this.#ownedRecord(request.agent);
      if (record === undefined || request.callId === undefined) return next();
      return withAbort(
        record.outputTail.then(() => {
          request.signal?.throwIfAborted();
          return this.#connection.requestPermission({
            sessionId: String(request.agent.id),
            toolCall: { toolCallId: String(request.callId) },
            options: [
              { optionId: "allow-once", name: "Allow once", kind: "allow_once" },
              { optionId: "reject-once", name: "Reject", kind: "reject_once" },
            ],
          });
        }),
        request.signal,
      )
        .then(({ outcome }) =>
          outcome.outcome === "cancelled"
            ? "cancelled"
            : outcome.optionId === "allow-once"
              ? "allowed-once"
              : "rejected",
        )
        .catch(() => "unavailable");
    }));
    const questions = this.#context.get("userQuestions") as
      | { registerProvider(provider: { ask(request: unknown): Promise<unknown> }): () => void }
      | undefined;
    const unregisterQuestions = questions?.registerProvider({ ask: (request) => this.#askQuestion(request) });
    if (unregisterQuestions !== undefined) this.#hooks.push(unregisterQuestions);
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
    let selection: ModelSelectionRef | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      handle = await this.#context.agents.create({
        sessionId,
        meta: { cwd: params.cwd },
        setup: (agentContext) => {
          selection = this.#installSelection(agentContext);
        },
      });
      if (this.#closed) throw new Error("adapter disposed during session creation");
      if (handle.agent.session.id !== sessionId || this.#sessions.has(sessionId)) {
        throw new Error("agent factory returned a duplicate or mismatched session id");
      }
      if (selection === undefined) throw new Error("agent setup did not install model selection");
      const record: SessionRecord = {
        handle,
        selection,
        toolCalls: new Map(),
        outputTail: Promise.resolve(),
        inflight: undefined,
      };
      this.#sessions.set(sessionId, record);
      await this.#sendCommands(record);
      return { sessionId: String(sessionId), configOptions: await this.#configOptions(record) };
    } catch (error) {
      await handle?.dispose().catch((disposeError: unknown) => {
        cleanupFailure = { error: disposeError };
        this.#diagnose("session/new cleanup", sessionId, disposeError);
      });
      this.#diagnose("session/new", sessionId, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to create DeepSeek session");
    } finally {
      this.#creations.delete(creationDone.promise);
      if (cleanupFailure === undefined) creationDone.resolve();
      else creationDone.reject(cleanupFailure.error);
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
    void loadDone.promise.catch(() => undefined);
    this.#loads.set(sessionId, loadDone.promise);
    let adopted = false;
    let resumed = false;
    let handle: AgentHandle | undefined;
    let selection: ModelSelectionRef | undefined;
    let cleanupFailure: { error: unknown } | undefined;
    try {
      const inspection = await this.#inspect(sessionId);
      if (inspection.meta.cwd !== params.cwd) {
        throw invalidParams("cwd does not match persisted session");
      }
      const resident = this.#sessions.get(sessionId);
      if (resident?.inflight !== undefined) {
        throw invalidParams("cannot load a session while its prompt is active");
      }
      const updates = await replayUpdates({
        context: this.#context,
        sessionId: String(sessionId),
        events: inspection.events,
        diagnose: (operation, error) => this.#diagnose(operation, sessionId, error),
      });
      if (resident !== undefined) {
        if (this.#context.agents.get(sessionId) !== resident.handle.agent) {
          throw new Error("owned session is no longer registered");
        }
        handle = resident.handle;
        selection = resident.selection;
      } else {
        if (this.#context.agents.get(sessionId) !== undefined) {
          throw new Error("session is already owned outside this ACP connection");
        }
        handle = await this.#context.agents.resume({
          resumeSessionId: sessionId,
          setup: (agentContext) => {
            selection = this.#installSelection(agentContext);
          },
        });
        resumed = true;
        if (this.#closed || this.#sessions.has(sessionId)) {
          throw new Error("adapter ownership changed during session load");
        }
        if (selection === undefined) throw new Error("agent setup did not install model selection");
        this.#sessions.set(sessionId, {
          handle,
          selection,
          toolCalls: new Map(),
          outputTail: Promise.resolve(),
          inflight: undefined,
        });
        adopted = true;
      }
      for (const update of updates) await this.#connection.sessionUpdate(update);
      const record = this.#sessions.get(sessionId);
      if (record === undefined) throw new Error("loaded session was not adopted");
      await this.#sendCommands(record);
      return { configOptions: await this.#configOptions(record) };
    } catch (error) {
      if ((adopted || resumed) && handle !== undefined) {
        if (adopted) this.#sessions.delete(sessionId);
        await handle.dispose().catch((disposeError: unknown) => {
          cleanupFailure = { error: disposeError };
          this.#diagnose("session/load cleanup", sessionId, disposeError);
        });
      }
      this.#diagnose("session/load", sessionId, error);
      if (error instanceof RequestError) throw error;
      throw internalError("unable to load DeepSeek session");
    } finally {
      this.#loads.delete(sessionId);
      if (cleanupFailure === undefined) loadDone.resolve();
      else loadDone.reject(cleanupFailure.error);
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
      await this.#disposeRecord(record);
      return {};
    } catch (error) {
      if (!this.#closed && !this.#sessions.has(sessionId)) {
        this.#sessions.set(sessionId, record);
      }
      this.#diagnose("session/close", sessionId, error);
      throw internalError("unable to close DeepSeek session");
    }
  }

  #installSelection(agentContext: Context): ModelSelectionRef {
    const agent = agentContext.agent;
    if (agent === undefined) throw new Error("agent setup has no scoped agent");
    const defaults = agentContext.get("agentDefaultModel") as
      | { currentSelection(): ModelSelection }
      | undefined;
    if (defaults === undefined) throw new Error("default model service is unavailable");
    let selected: ModelSelection | undefined;
    const selection: ModelSelectionRef = {
      get current(): ModelSelection {
        if (selected !== undefined) return selected;
        const logged = agent.session.requestHeader()?.config;
        if (logged === undefined) return defaults.currentSelection();
        return {
          provider: logged.provider,
          model: logged.model,
          ...(logged.reasoningEffort === undefined ? {} : { reasoningEffort: logged.reasoningEffort }),
        };
      },
      set current(value: ModelSelection | undefined) {
        selected = value;
      },
      assembled: undefined,
    };
    installSelection(agentContext, selection);
    return selection;
  }

  #sendCommands(record: SessionRecord): Promise<void> {
    const availableCommands = this.#commands(record.handle.agent);
    if (availableCommands.length === 0) return Promise.resolve();
    return this.#connection.sessionUpdate({
      sessionId: String(record.handle.agent.id),
      update: { sessionUpdate: "available_commands_update", availableCommands },
    });
  }

  #commands(agent?: Agent): { name: string; description: string; input?: { hint: string } }[] {
    const commands = this.#context.get("commands") as
      | { list(agent: Agent): readonly { name: string; description: string; input?: { hint: string } }[] }
      | undefined;
    if (commands === undefined) throw new Error("command service is unavailable");
    // The pinned registry treats an absent scope as its global command view.
    const descriptors = commands.list(agent ?? (undefined as unknown as Agent));
    return descriptors.map((command) => ({
      name: command.name,
      description: command.description,
      ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
    }));
  }

  async #catalog(): Promise<CatalogResponse> {
    const llm = this.#context.get("llm") as Context["llm"] | undefined;
    const defaults = this.#context.get("agentDefaultModel") as
      | { currentSelection(): ModelSelection }
      | undefined;
    if (llm === undefined || defaults === undefined) throw new Error("model catalog services are unavailable");
    const providers = await Promise.all(
      llm.listProviders().map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id);
          const entries: CatalogModel[] = await Promise.all(
            models.map(async (model) => {
              const resolved = await llm.resolveModelInfo(provider.id, model.id);
              return {
                id: selectionId({ provider: provider.id, model: model.id }),
                upstreamModelId: model.id,
                name: model.name,
                reasoningEfforts: resolved.reasoning?.efforts.map((effort) => String(effort.id)) ?? [],
                defaultReasoningEffort:
                  resolved.reasoning?.defaultEffort === undefined
                    ? null
                    : String(resolved.reasoning.defaultEffort),
                supportsImages: resolved.inputModalities?.includes("image") === true,
              };
            }),
          );
          return { provider: { id: provider.id, name: provider.name, models: entries } };
        } catch (error) {
          this.#diagnose("deepseek/catalog provider", undefined, error);
          return {
            failure: {
              providerId: provider.id,
              category: "unavailable",
              message: "Provider catalog unavailable",
            },
          };
        }
      }),
    );
    const response: CatalogResponse = {
      agent: { id: "deepseek", name: "DeepSeek", primary: true },
      providers: providers.flatMap((item) =>
        "provider" in item && item.provider.models.length > 0 ? [item.provider] : [],
      ),
      defaultSelectionId: selectionId(defaults.currentSelection()),
      commands: this.#commands().map(({ name, description }) => ({ name, description })),
      failures: providers.flatMap((item) => ("failure" in item ? [item.failure] : [])),
    };
    if (!validateProtocolValue({ definition: "catalogResponse", value: response }).valid) {
      throw new Error("DeepSeek catalog response exceeds protocol bounds");
    }
    return response;
  }

  async #configOptions(record: SessionRecord): Promise<SessionConfigOption[]> {
    const catalog = await this.#catalog();
    if (catalog.providers.length === 0) return [];
    const current = record.selection.current;
    if (current === undefined) throw new Error("session has no model selection");
    const selectedId = selectionId(current);
    const selectedModel = catalog.providers
      .flatMap((provider) => provider.models)
      .find((model) => model.id === selectedId);
    if (selectedModel === undefined) throw new Error("selected model is unavailable from the current catalog");
    const options: SessionConfigOption[] = [
      {
        type: "select",
        id: MODEL_CONFIG_ID,
        name: "Model",
        category: "model",
        currentValue: selectedId,
        options: catalog.providers.map((provider) => ({
          group: provider.id,
          name: provider.name,
          options: provider.models.map((model) => ({ value: model.id, name: model.name })),
        })),
      },
    ];
    const currentEffort = current.reasoningEffort ?? selectedModel.defaultReasoningEffort;
    if (currentEffort !== null && selectedModel.reasoningEfforts.length > 0) {
      options.push({
        type: "select",
        id: REASONING_CONFIG_ID,
        name: "Reasoning effort",
        category: "thought_level",
        currentValue: String(currentEffort),
        options: selectedModel.reasoningEfforts.map((effort) => ({ value: effort, name: effort })),
      });
    }
    return options;
  }

  async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
    this.#assertOpen();
    if (typeof params.value !== "string") throw invalidParams("DeepSeek config options require a selection value");
    const record = this.#sessions.get(parseSessionId(params.sessionId));
    if (record === undefined) throw invalidParams("unknown session");
    const catalog = await this.#catalog();
    const current = record.selection.current;
    if (current === undefined) throw internalError("session has no model selection");
    if (params.configId === MODEL_CONFIG_ID) {
      const decoded = decodeSelectionId(params.value);
      const model = catalog.providers.flatMap((provider) => provider.models).find((item) => item.id === params.value);
      if (decoded === undefined || model === undefined) throw invalidParams("unknown DeepSeek model selection");
      record.selection.current = {
        ...decoded,
        ...(model.defaultReasoningEffort === null
          ? {}
          : { reasoningEffort: ReasoningEffortId(model.defaultReasoningEffort) }),
      };
    } else if (params.configId === REASONING_CONFIG_ID) {
      const model = catalog.providers
        .flatMap((provider) => provider.models)
        .find((item) => item.id === selectionId(current));
      if (model === undefined || !model.reasoningEfforts.includes(params.value)) {
        throw invalidParams("unknown DeepSeek reasoning effort");
      }
      record.selection.current = { ...current, reasoningEffort: ReasoningEffortId(params.value) };
    } else {
      throw invalidParams("unknown DeepSeek config option");
    }
    return { configOptions: await this.#configOptions(record) };
  }

  async extMethod(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    this.#assertOpen();
    if (method === "deepseek/catalog") {
      if (!validateProtocolValue({ definition: "catalogRequest", value: params }).valid) {
        throw invalidParams("invalid DeepSeek catalog request");
      }
      return (await this.#catalog()) as unknown as Record<string, unknown>;
    }
    if (method === "deepseek/session/rename") return this.#rename(params);
    if (method !== "deepseek/session/history") throw RequestError.methodNotFound(method);
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
          diagnose: (operation, error) => this.#diagnose(operation, sessionId, error),
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

  async #rename(params: Record<string, unknown>): Promise<Record<string, unknown>> {
    if (!validateProtocolValue({ definition: "renameRequest", value: params }).valid) {
      throw invalidParams("invalid DeepSeek rename request");
    }
    const sessionId = parseSessionId(params.sessionId as string);
    const loading = this.#loads.get(sessionId);
    if (loading !== undefined) await loading;
    const closing = this.#closes.get(sessionId);
    if (closing !== undefined) await closing;
    const titles = this.#context.get("sessionTitle") as
      | { rename(session: Agent["session"], title: string): { title: string } }
      | undefined;
    if (titles === undefined) throw internalError("session title service is unavailable");
    const record = this.#sessions.get(sessionId);
    if (record !== undefined) {
      try {
        const renamed = titles.rename(record.handle.agent.session, params.title as string);
        if (!(await this.#context.sessions.flush(record.handle.agent.session))) {
          throw new Error("session persistence did not participate in rename");
        }
        await record.outputTail;
        return this.#renameResponse(renamed.title);
      } catch (error) {
        this.#diagnose("deepseek/session/rename", sessionId, error);
        if (error instanceof SessionTitleInvalidError) throw invalidParams("invalid DeepSeek session title");
        throw internalError("unable to rename DeepSeek session");
      }
    }
    if (this.#context.agents.get(sessionId) !== undefined) {
      throw invalidParams("session is already being used outside this ACP connection");
    }
    const transition = Promise.withResolvers<void>();
    void transition.promise.catch(() => undefined);
    this.#loads.set(sessionId, transition.promise);
    let handle: AgentHandle | undefined;
    let cleanupFailure: unknown;
    let operationFailure: RequestError | undefined;
    let response: Record<string, unknown> | undefined;
    try {
      handle = await this.#context.agents.resume({ resumeSessionId: sessionId });
      if (this.#closed || this.#sessions.has(sessionId)) {
        throw new Error("adapter ownership changed during session rename");
      }
      const renamed = titles.rename(handle.agent.session, params.title as string);
      if (!(await this.#context.sessions.flush(handle.agent.session))) {
        throw new Error("session persistence did not participate in rename");
      }
      await this.#connection.sessionUpdate({
        sessionId: String(sessionId),
        update: { sessionUpdate: "session_info_update", title: renamed.title },
      });
      response = this.#renameResponse(renamed.title);
    } catch (error) {
      this.#diagnose("deepseek/session/rename", sessionId, error);
      operationFailure =
        error instanceof SessionTitleInvalidError
          ? invalidParams("invalid DeepSeek session title")
          : internalError("unable to rename DeepSeek session");
    }
    await handle?.dispose().catch((error: unknown) => {
      cleanupFailure = error;
      this.#diagnose("deepseek/session/rename cleanup", sessionId, error);
    });
    this.#loads.delete(sessionId);
    if (cleanupFailure === undefined) transition.resolve();
    else transition.reject(cleanupFailure);
    if (cleanupFailure !== undefined) throw internalError("unable to release renamed DeepSeek session");
    if (operationFailure !== undefined) throw operationFailure;
    if (response === undefined) throw internalError("DeepSeek rename did not produce a response");
    return response;
  }

  #renameResponse(title: string): Record<string, unknown> {
    const response = { title };
    if (!validateProtocolValue({ definition: "renameResponse", value: response }).valid) {
      throw new Error("DeepSeek rename response exceeds protocol bounds");
    }
    return response;
  }

  async prompt(params: PromptRequest): Promise<PromptResponse> {
    this.#assertOpen();
    const sessionId = parseSessionId(params.sessionId);
    if (this.#loads.has(sessionId)) throw invalidParams("session load is in progress");
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw invalidParams("unknown session");
    if (record.inflight !== undefined) throw invalidParams("a prompt is already in flight for this session");
    const inflight: InflightPrompt = {
      completion: Promise.withResolvers<StopReason>(),
      admission: Promise.withResolvers<void>(),
      terminal: Promise.withResolvers<void>(),
      controller: new AbortController(),
      queued: false,
      cancelled: false,
      settling: false,
      command: false,
      usageByStep: new Map(),
    };
    record.inflight = inflight;
    try {
      const candidate = commandPrompt(params.prompt);
      const parsed = candidate === undefined ? undefined : parseCommand(candidate.line);
      const commands = this.#context.get("commands") as
        | {
            find(agent: Agent, name: string): unknown;
            execute(agent: Agent, line: string, images: readonly EncodedImageAttachment[], signal: AbortSignal): Promise<unknown>;
          }
        | undefined;
      if (commands === undefined) throw new Error("command service is unavailable");
      if (parsed !== undefined && commands.find(record.handle.agent, parsed.name) !== undefined) {
        inflight.command = true;
        inflight.queued = true;
        try {
          const execution = await commands.execute(
            record.handle.agent,
            candidate!.line,
            candidate!.images,
            inflight.controller.signal,
          );
          if (execution === undefined) throw new Error("advertised DeepSeek command disappeared during admission");
          inflight.endReason = { kind: "completed" };
        } catch (error) {
          if (!inflight.cancelled) {
            inflight.agentError = error;
            this.#diagnose("session/command", record.handle.agent.id, error);
          }
        }
        inflight.terminal.resolve();
        inflight.admission.resolve();
        this.#settle(record, inflight);
        const stopReason = await inflight.completion.promise;
        return { stopReason };
      }
      const messageId = promptMessageId(params);
      const content = await admitPrompt({
        context: this.#context,
        prompt: params.prompt,
        signal: inflight.controller.signal,
      });
      inflight.controller.signal.throwIfAborted();
      const message = freezeMessage({
        id: MessageId(messageId),
        role: "user",
        source: { kind: "user" },
        content,
      });
      inflight.messageId = messageId;
      inflight.queued = true;
      record.handle.agent.followup(message);
    } catch (error) {
      if (!inflight.cancelled) {
        record.inflight = undefined;
        if (error instanceof RequestError) throw error;
        if (isImageAdmissionError(error)) throw invalidParams("image prompt was not admitted");
        throw internalError("prompt was not admitted");
      }
    } finally {
      inflight.admission.resolve();
    }
    this.#settle(record, inflight);
    const stopReason = await inflight.completion.promise;
    const usage = promptUsage(inflight.usageByStep.values());
    return { stopReason, ...(usage === undefined ? {} : { usage }) };
  }

  async cancel(params: CancelNotification): Promise<void> {
    const record = this.#sessions.get(parseSessionId(params.sessionId));
    if (record === undefined) return;
    const inflight = record.inflight;
    if (inflight !== undefined) {
      inflight.cancelled = true;
      inflight.controller.abort(new Error("ACP prompt cancelled"));
      inflight.terminal.resolve();
      this.#settle(record, inflight);
    }
    if (inflight === undefined || inflight.queued) record.handle.agent.cancel({ kind: "user" });
  }

  dispose(): Promise<void> {
    this.#disposal ??= this.#dispose();
    return this.#disposal;
  }

  #ownedRecord(agent: Agent): SessionRecord | undefined {
    const record = this.#sessions.get(agent.id);
    return record?.handle.agent === agent ? record : undefined;
  }

  #queue(record: SessionRecord, task: () => Promise<void>): void {
    const inflight = record.inflight;
    record.outputTail = record.outputTail.catch(() => undefined).then(task);
    void record.outputTail.catch((error: unknown) => {
      if (inflight !== undefined) inflight.outputError ??= error;
    });
  }

  #projectEvent(record: SessionRecord, event: SessionEvent): void {
    const sessionId = String(record.handle.agent.id);
    this.#queue(record, () =>
      projectSessionEvent(
        {
          context: this.#context,
          sessionId,
          agent: record.handle.agent,
          mode: "live",
          toolCalls: record.toolCalls,
          emitUpdate: (update) => this.#connection.sessionUpdate({ sessionId, update }),
          emitStatus: (status) => this.#connection.extNotification("deepseek/session/status", status),
          diagnose: (operation, error) => this.#diagnose(operation, record.handle.agent.id, error),
          onUsage: (turn, step, usage) => {
            const inflight = record.inflight;
            if (inflight?.turn === turn && !inflight.usageByStep.has(step)) {
              inflight.usageByStep.set(step, usage);
            }
          },
          onTurnEnd: (turn, reason) => {
            const inflight = record.inflight;
            if (inflight?.turn === turn) {
              inflight.endReason = reason;
              inflight.terminal.resolve();
            }
          },
        },
        event,
      ),
    );
  }

  #settle(record: SessionRecord, inflight: InflightPrompt): void {
    if (inflight.settling) return;
    inflight.settling = true;
    void (async () => {
      await inflight.admission.promise;
      if (inflight.queued) {
        await inflight.terminal.promise;
        await record.handle.agent.whenIdle();
      }
      await record.outputTail;
      if (inflight.queued && !(await this.#context.sessions.flush(record.handle.agent.session))) {
        throw new Error("session persistence did not participate in prompt settlement");
      }
      if (record.inflight !== inflight) return;
      record.inflight = undefined;
      if (inflight.cancelled) return inflight.completion.resolve("cancelled");
      if (inflight.outputError !== undefined || inflight.agentError !== undefined) {
        return inflight.completion.reject(internalError("turn output failed"));
      }
      const reason = inflight.endReason as { kind?: string } | undefined;
      if (reason?.kind === "blocked") return inflight.completion.resolve("refusal");
      if (reason?.kind === "aborted") return inflight.completion.resolve("cancelled");
      if (reason?.kind === "max-tokens") return inflight.completion.resolve("max_tokens");
      if (reason?.kind === "error") return inflight.completion.reject(internalError("turn failed"));
      if (reason?.kind === "interrupted") return inflight.completion.reject(internalError("turn interrupted"));
      inflight.completion.resolve("end_turn");
    })().catch((error: unknown) => {
      if (record.inflight === inflight) record.inflight = undefined;
      inflight.completion.reject(internalError("prompt settlement failed"));
      this.#diagnose("session/prompt settlement", record.handle.agent.id, error);
    });
  }

  async #askQuestion(value: unknown): Promise<unknown> {
    const request = value as { agent?: Agent; signal?: AbortSignal; questions?: unknown[] };
    if (request.agent === undefined) {
      throw new Error("question caller is not an owned root session");
    }
    const record = this.#ownedRecord(request.agent);
    if (record === undefined) throw new Error("question caller is not an owned root session");
    const questionIds = new Set<string>();
    const questions = (request.questions ?? []).map((question) => {
      const item = question as Record<string, unknown>;
      const intent = item.intent as { kind?: string; approve?: string } | undefined;
      if (typeof item.id !== "string" || questionIds.has(item.id)) {
        throw new Error("invalid or duplicate DeepSeek question id");
      }
      questionIds.add(item.id);
      const options = Array.isArray(item.options)
        ? item.options.map((option) => (option as { label: string }).label)
        : undefined;
      if (options !== undefined && new Set(options).size !== options.length) {
        throw new Error("duplicate DeepSeek question option");
      }
      if (intent?.kind === "plan-review" && !options?.includes(intent.approve as string)) {
        throw new Error("invalid DeepSeek plan approval label");
      }
      return {
        id: item.id,
        text: item.question,
        ...(item.header === undefined ? {} : { header: item.header }),
        ...(item.detail === undefined ? {} : { detail: item.detail }),
        ...(options === undefined ? {} : { options }),
        ...(item.multiSelect === undefined ? {} : { multiSelect: item.multiSelect }),
        ...(intent?.kind === "plan-review" ? { intent: "plan_review", approveLabel: intent.approve } : {}),
      };
    });
    const params = { sessionId: String(request.agent.id), questions };
    if (!validateProtocolValue({ definition: "askUserQuestionRequest", value: params }).valid) {
      throw new Error("invalid DeepSeek question request");
    }
    request.signal?.throwIfAborted();
    const response = await withAbort(record.outputTail.then(() => {
      request.signal?.throwIfAborted();
      return this.#connection.extMethod("deepseek/ask_user_question", params);
    }), request.signal);
    if (!validateProtocolValue({ definition: "askUserQuestionResponse", value: response }).valid) {
      throw new Error("invalid DeepSeek question response");
    }
    const answers = response.answers as { questionId: string; selectedLabels: string[]; customAnswer?: string }[];
    if (answers.length !== questions.length || answers.some((answer, index) => answer.questionId !== questions[index]?.id)) {
      throw new Error("DeepSeek question response does not match request");
    }
    for (const [index, answer] of answers.entries()) {
      const question = questions[index]!;
      if (new Set(answer.selectedLabels).size !== answer.selectedLabels.length) {
        throw new Error("DeepSeek question response repeats a selection");
      }
      if (answer.selectedLabels.some((label) => !question.options?.includes(label))) {
        throw new Error("DeepSeek question response contains an unknown selection");
      }
      if (question.multiSelect !== true && (answer.selectedLabels.length > 1 || (answer.selectedLabels.length > 0 && answer.customAnswer !== undefined))) {
        throw new Error("DeepSeek single-select response is invalid");
      }
      if (answer.selectedLabels.length === 0 && answer.customAnswer === undefined) {
        throw new Error("DeepSeek question response is empty");
      }
    }
    return { answers: answers.map((answer) => ({ id: answer.questionId, selected: answer.selectedLabels, ...(answer.customAnswer === undefined ? {} : { custom: answer.customAnswer }) })) };
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

  async #disposeRecord(record: SessionRecord): Promise<void> {
    const inflight = record.inflight;
    if (inflight !== undefined) {
      inflight.cancelled = true;
      inflight.controller.abort(new Error("ACP session owner disposed"));
      inflight.terminal.resolve();
      record.handle.agent.cancel({ kind: "disposed" });
      this.#settle(record, inflight);
    }
    let handleFailure: { error: unknown } | undefined;
    await record.handle.dispose().catch((error: unknown) => {
      handleFailure = { error };
    });
    await Promise.allSettled([
      record.outputTail,
      ...(inflight === undefined ? [] : [inflight.completion.promise]),
    ]);
    if (handleFailure !== undefined) throw handleFailure.error;
  }

  #diagnose(operation: string, sessionId: SessionId | undefined, error: unknown): void {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    this.#diagnostics.write(
      `sesori-deepseek-acp: ${operation}${sessionId === undefined ? "" : ` session=${sessionId}`}: ${detail}\n`,
    );
  }

  async #dispose(): Promise<void> {
    this.#closed = true;
    for (const disposeHook of this.#hooks.splice(0).reverse()) disposeHook();
    const transitionOutcomes = await Promise.allSettled([
      ...this.#creations,
      ...this.#loads.values(),
      ...this.#closes.values(),
    ]);
    const records = [...this.#sessions.values()];
    this.#sessions.clear();
    const outcomes = await Promise.allSettled(records.map((record) => this.#disposeRecord(record)));
    const failures = [...transitionOutcomes, ...outcomes].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "failed to dispose DeepSeek sessions");
  }
}
