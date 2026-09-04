import { AsyncLocalStorage } from "node:async_hooks";
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
import { SessionTitleInvalidError } from "@deepseek-ai/dsh-session-title";
import type { SubagentRunEndInfo, SubagentRunInfo } from "@deepseek-ai/dsh-subagent";
import type {} from "@deepseek-ai/dsh-tools";
import { createInitializeResponse, INITIALIZE_METADATA_KEY } from "./protocol.js";
import type { SubagentBindingStore } from "./subagent_bindings.js";
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
const SUBAGENT_NOTIFICATION_METHOD = "deepseek/subagent";
const MAX_SUBAGENT_LABEL_LENGTH = 256;
const MAX_SUBAGENT_SUMMARY_LENGTH = 512;

type SubagentMode = "foreground" | "background";
type SubagentStopReason = "completed" | "aborted" | "error" | "max-tokens" | "refusal";

/** Delegation tools of the pinned dsh profile and the mode each uses when `run_in_background` is omitted. */
const SUBAGENT_TOOL_DEFAULT_MODES: ReadonlyMap<string, SubagentMode> = new Map([
  ["subagent", "background"],
  ["subagent_fork", "foreground"],
]);
const SUBAGENT_STOP_REASONS: ReadonlySet<string> = new Set<SubagentStopReason>([
  "completed",
  "aborted",
  "error",
  "max-tokens",
  "refusal",
]);

interface SubagentCallView {
  label: string;
  mode: SubagentMode;
}

interface SubagentReplayMeta {
  label: string;
  mode: SubagentMode;
  childSessionId?: string;
  ended?: { stopReason: SubagentStopReason; summary?: string };
}

function boundedText(value: unknown, maxLength: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim().slice(0, maxLength);
  return /\S/u.test(text) ? text : undefined;
}

function subagentCallView(name: string, args: unknown): SubagentCallView | undefined {
  const defaultMode = SUBAGENT_TOOL_DEFAULT_MODES.get(name);
  if (defaultMode === undefined) return undefined;
  const record = typeof args === "object" && args !== null ? (args as Record<string, unknown>) : {};
  const background = record.run_in_background;
  return {
    label: boundedText(record.description, MAX_SUBAGENT_LABEL_LENGTH) ?? name,
    mode: typeof background === "boolean" ? (background ? "background" : "foreground") : defaultMode,
  };
}

function subagentStopReason(value: string): SubagentStopReason {
  return SUBAGENT_STOP_REASONS.has(value) ? (value as SubagentStopReason) : "error";
}

function subagentSummary(blocks: readonly ContentBlock[] | undefined): string | undefined {
  if (blocks === undefined) return undefined;
  return boundedText(
    blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n"),
    MAX_SUBAGENT_SUMMARY_LENGTH,
  );
}

/** The `subagent` tool renders a continuable start as `started subagent <id>`; the id is the child session id. */
function continuableChildId(blocks: readonly ContentBlock[]): string | undefined {
  const text = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("");
  const match = /^started subagent (\S+)$/u.exec(text.trim());
  return match?.[1];
}

/** Map the `subagent` tool's failed-result headline (`stopReasonError`) back to the closed stop-reason vocabulary. */
function foregroundStopReason(blocks: readonly ContentBlock[]): SubagentStopReason {
  const headline = blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("").split("\n")[0] ?? "";
  if (headline.includes("was cancelled")) return "aborted";
  if (headline.includes("token limit")) return "max-tokens";
  if (headline.includes("declined the task")) return "refusal";
  return "error";
}

/** Map dsh's settlement notice wording (`settlementSummary`) back to its closed stop-reason vocabulary. */
function settledStopReason(summary: string): SubagentStopReason {
  if (summary.includes("finished and will do no further work")) return "completed";
  if (summary.includes("was stopped before it finished")) return "aborted";
  if (summary.includes("ran out of room")) return "max-tokens";
  if (summary.includes("declined the task")) return "refusal";
  return "error";
}

interface ReplayChildren {
  /** Durable `toolCallId -> childSessionId` bindings recorded at each live `subagent/start`. */
  bindings: ReadonlyMap<string, string>;
  /** Continuable child id to the parent call that started it, for the later settlement notice. */
  continuable: Map<string, { callId: string; label: string }>;
}

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

interface ToolCallRecord {
  name: string;
  arguments: string;
  time?: number;
}

interface SessionRecord {
  readonly handle: AgentHandle;
  readonly selection: ModelSelectionRef;
  readonly toolCalls: Map<string, ToolCallRecord>;
  readonly messageCreatedAt: Map<string, number>;
  outputTail: Promise<void>;
  inflight: InflightPrompt | undefined;
}

/** A live dsh child whose direct parent is an owned root or another registered child. */
interface ChildRecord {
  readonly agent: Agent;
  readonly parentId: SessionId;
  readonly toolCalls: Map<string, ToolCallRecord>;
  readonly messageCreatedAt: Map<string, number>;
  outputTail: Promise<void>;
  lifecycle: { readonly kind: "unannounced" } | { readonly kind: "announced"; readonly mode: SubagentMode };
  /** Settled, but retained because a registered descendant still resolves its lineage through it. */
  ended: boolean;
}

/** The delegation tool call executing on the current async chain, read when dsh publishes `subagent/start`. */
interface SubagentCallScope {
  readonly callId: string;
  readonly agentId: SessionId;
  readonly view: SubagentCallView;
}

function selectionId(selection: Pick<ModelSelection, "provider" | "model">): string {
  const id = `v1${Buffer.from(JSON.stringify([selection.provider, selection.model])).toString("base64url")}`;
  if (id.length > 512) throw new Error("DeepSeek model selection id exceeds protocol bounds");
  return id;
}

function decodeSelectionId(value: string): Pick<ModelSelection, "provider" | "model"> | undefined {
  if (value.length > 512 || !value.startsWith("v1")) return undefined;
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

function sessionInfo(header: SessionHeader): SessionInfo {
  if (header.cwd === undefined || !isAbsolute(header.cwd)) {
    throw internalError("persisted session has no valid working directory");
  }
  return {
    sessionId: String(header.id),
    cwd: header.cwd,
    updatedAt: new Date(header.createdAt).toISOString(),
    _meta: { [INITIALIZE_METADATA_KEY]: headerMetadata(header) },
  };
}

function historyRequest(params: Record<string, unknown>): HistoryRequest {
  const validation = validateProtocolValue({ definition: "historyRequest", value: params });
  if (!validation.valid) throw invalidParams("invalid DeepSeek history request");
  return params as unknown as HistoryRequest;
}

function promptImages(prompt: PromptRequest["prompt"]): EncodedImageAttachment[] {
  return prompt.filter((block) => block.type === "image").map((image) => {
    if (image.uri !== undefined && image.uri !== null) throw invalidParams("image URLs are not supported");
    if (!["image/png", "image/jpeg", "image/webp", "image/gif"].includes(image.mimeType)) {
      throw invalidParams("unsupported image media type");
    }
    if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(image.data)) {
      throw invalidParams("invalid image base64");
    }
    return { data: image.data, mediaType: image.mimeType as EncodedImageAttachment["mediaType"] };
  });
}

async function admitPrompt(args: {
  context: Context;
  prompt: PromptRequest["prompt"];
  signal: AbortSignal;
}): Promise<UserMessage["content"]> {
  const images = promptImages(args.prompt);
  const attachments = args.context.get("attachments") as
    | { saveImages(inputs: readonly { data: Uint8Array; mediaType: string }[]): Promise<readonly unknown[]> }
    | undefined;
  if (images.length > 0 && attachments === undefined) throw invalidParams("image prompts are unavailable");
  const inputs = images.map((image) => ({ data: Buffer.from(image.data, "base64"), mediaType: image.mediaType }));
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
  if (event.type === "command/done") return event.data.text !== undefined;
  return (
    isAppendSurfaceEvent(event) &&
    ((event.type === "user/message" && event.data.source.kind === "user") || event.type === "assistant/message")
  );
}

function isAssistantContentChunk(
  event: SessionEvent,
): event is Extract<SessionEvent, { type: "assistant/chunk" }> {
  return (
    event.type === "assistant/chunk" &&
    (event.data.chunk.type === "text-delta" || event.data.chunk.type === "reasoning-delta")
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
  let firstEventIndex = starts[selectedStartIndex] as number;
  const boundary = eligible[firstEventIndex];
  if (boundary?.type === "assistant/message") {
    while (firstEventIndex > 0) {
      const candidate = eligible[firstEventIndex - 1];
      if (
        candidate?.type !== "assistant/chunk" ||
        candidate.data.turn !== boundary.data.turn ||
        candidate.data.step !== boundary.data.step
      ) break;
      firstEventIndex -= 1;
    }
  }
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
  toolCalls: Map<string, ToolCallRecord>;
  messageCreatedAt: Map<string, number>;
  replayChildren?: ReplayChildren;
  emitUpdate(
    update: SessionNotification["update"],
    messageCreatedAt?: number,
    subagent?: SubagentReplayMeta,
  ): Promise<void>;
  emitStatus?(status: Record<string, unknown>): Promise<void>;
  diagnose(operation: string, error: unknown): void;
  onUsage?(turn: number, step: number, usage: TokenUsage): void;
  onTurnEnd?(turn: number, reason: unknown): void;
}

function eventTime(event: SessionEvent): number | undefined {
  return Number.isSafeInteger(event.time) && event.time >= 0 ? event.time : undefined;
}

function firstMessageTime(args: EventProjection, id: string, time: number | undefined): number | undefined {
  const existing = args.messageCreatedAt.get(id);
  if (existing !== undefined) return existing;
  if (time !== undefined) args.messageCreatedAt.set(id, time);
  return time;
}

async function projectSessionEvent(args: EventProjection, event: SessionEvent): Promise<void> {
  if (!KNOWN_SESSION_EVENT_TYPES.has(event.type)) return;
  if (event.type === "turn/start" && args.mode === "live") {
    args.messageCreatedAt.clear();
    return;
  }
  if (event.type === "user/message" && isAppendSurfaceEvent(event)) {
    if (args.mode === "live") return;
    const source = event.data.source as { kind: string; senderSessionId?: unknown; summary?: unknown };
    if (source.kind === "subagent-settled") {
      const childSessionId = typeof source.senderSessionId === "string" ? source.senderSessionId : undefined;
      const started = childSessionId === undefined ? undefined : args.replayChildren?.continuable.get(childSessionId);
      if (childSessionId === undefined || started === undefined) return;
      args.replayChildren?.continuable.delete(childSessionId);
      await args.emitUpdate(
        { sessionUpdate: "tool_call_update", toolCallId: started.callId, status: "completed" },
        eventTime(event),
        {
          label: started.label,
          mode: "background",
          childSessionId,
          ended: { stopReason: settledStopReason(typeof source.summary === "string" ? source.summary : "") },
        },
      );
      return;
    }
    if (source.kind !== "user") return;
    for (const block of event.data.content) {
      if (block.type !== "text" && block.type !== "image") {
        throw new Error("session history contains unsupported user content");
      }
      await args.emitUpdate(
        {
          sessionUpdate: "user_message_chunk",
          messageId: String(event.data.id),
          content:
            block.type === "text"
              ? { type: "text", text: block.text }
              : await imageContent({ context: args.context, attachment: block.attachment }),
        },
        eventTime(event),
      );
    }
    return;
  }
  if (event.type === "assistant/chunk" && args.mode === "live") {
    const chunk = event.data.chunk;
    if (chunk.type === "text-delta" || chunk.type === "reasoning-delta") {
      const messageId = assistantMessageId(args.sessionId, event.data.turn, event.data.step);
      await args.emitUpdate(
        {
          sessionUpdate: chunk.type === "reasoning-delta" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId,
          content: { type: "text", text: chunk.text },
        },
        firstMessageTime(args, `assistant:${messageId}`, eventTime(event)),
      );
    } else if (chunk.type === "usage") {
      args.onUsage?.(event.data.turn, event.data.step, chunk.usage);
    }
    return;
  }
  if (event.type === "assistant/message" && isAppendSurfaceEvent(event)) {
    if (event.data.usage !== undefined) {
      args.onUsage?.(event.data.turn, event.data.step, event.data.usage);
    }
    const messageId = assistantMessageId(args.sessionId, event.data.turn, event.data.step);
    for (const block of event.data.message.content) {
      if (block.type === "tool-call") continue;
      if (block.type === "tool-result") {
        throw new Error("session history contains unsupported assistant tool-result content");
      }
      if (args.mode === "live" && block.type !== "image") continue;
      await args.emitUpdate(
        {
          sessionUpdate: block.type === "reasoning" ? "agent_thought_chunk" : "agent_message_chunk",
          messageId,
          content:
            block.type === "image"
              ? await imageContent({ context: args.context, attachment: block.attachment })
              : { type: "text", text: block.text },
        },
        firstMessageTime(args, `assistant:${messageId}`, eventTime(event)),
      );
    }
    return;
  }
  if (event.type === "tool/call") {
    const callId = String(event.data.callId);
    const time = eventTime(event);
    args.toolCalls.set(callId, {
      name: event.data.name,
      arguments: event.data.arguments,
      ...(time === undefined ? {} : { time }),
    });
    const update: Extract<SessionNotification["update"], { sessionUpdate: "tool_call" }> = {
      sessionUpdate: "tool_call",
      toolCallId: callId,
      title: event.data.name,
      status: "in_progress",
    };
    const subagent = args.mode === "replay" ? replaySubagentCall(event.data.name, event.data.arguments) : undefined;
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
    await args.emitUpdate(update, firstMessageTime(args, `tool:${callId}`, time), subagent);
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
    const subagent =
      args.mode === "replay" && call !== undefined
        ? replaySubagentResult({
            callId,
            call,
            content: result.content,
            failed: update.status === "failed",
            children: args.replayChildren,
          })
        : undefined;
    await args.emitUpdate(update, firstMessageTime(args, `tool:${callId}`, eventTime(event)), subagent);
    return;
  }
  if (event.type === "command/done" && event.data.text !== undefined) {
    await args.emitUpdate(
      {
        sessionUpdate: "agent_message_chunk",
        messageId: commandMessageId(args.sessionId, String(event.data.commandId)),
        content: { type: "text", text: event.data.text },
      },
      eventTime(event),
    );
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
    args.messageCreatedAt.clear();
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

function replaySubagentCall(name: string, rawArguments: string): SubagentReplayMeta | undefined {
  if (!SUBAGENT_TOOL_DEFAULT_MODES.has(name)) return undefined;
  let parsed: unknown;
  try {
    parsed = parseToolArguments(rawArguments);
  } catch {
    parsed = undefined;
  }
  return subagentCallView(name, parsed);
}

/**
 * Fold a delegation's identity once its tool result lands. The child id comes
 * from the binding recorded at the live `subagent/start` (or, for a continuable
 * child, the result text); a continuable child settles later through its
 * notice, a foreground child settles with the result.
 */
function replaySubagentResult(args: {
  callId: string;
  call: ToolCallRecord;
  content: readonly ContentBlock[];
  failed: boolean;
  children: ReplayChildren | undefined;
}): SubagentReplayMeta | undefined {
  const view = replaySubagentCall(args.call.name, args.call.arguments);
  if (view === undefined) return undefined;
  const bound = args.children?.bindings.get(args.callId);
  if (view.mode === "background") {
    const childSessionId = (args.call.name === "subagent" ? continuableChildId(args.content) : undefined) ?? bound;
    if (childSessionId === undefined) return view;
    args.children?.continuable.set(childSessionId, { callId: args.callId, label: view.label });
    return { ...view, childSessionId };
  }
  const ended = { stopReason: args.failed ? foregroundStopReason(args.content) : ("completed" as const) };
  return bound === undefined ? { ...view, ended } : { ...view, childSessionId: bound, ended };
}

function hasSubagentCall(events: readonly SessionEvent[]): boolean {
  return events.some((event) => event.type === "tool/call" && SUBAGENT_TOOL_DEFAULT_MODES.has(event.data.name));
}

function updateMetadata(
  messageTime: number | undefined,
  subagent: SubagentReplayMeta | undefined,
): Pick<SessionNotification, "_meta"> {
  if (messageTime === undefined && subagent === undefined) return {};
  return {
    _meta: {
      [PROMPT_METADATA_KEY]: {
        ...(messageTime === undefined ? {} : { messageCreatedAt: messageTime }),
        ...(subagent === undefined ? {} : { subagent }),
      },
    },
  };
}

/**
 * Continuable children started before the replayed page, so a settlement notice
 * on this page still folds onto the call that started it on an earlier page.
 */
function priorContinuable(events: readonly SessionEvent[]): ReplayChildren["continuable"] {
  const continuable: ReplayChildren["continuable"] = new Map();
  const calls = new Map<string, ToolCallRecord>();
  for (const event of events) {
    if (event.type === "tool/call" && event.data.name === "subagent") {
      calls.set(String(event.data.callId), { name: event.data.name, arguments: event.data.arguments });
    } else if (event.type === "tool/result" && isAppendSurfaceEvent(event)) {
      const result = event.data.message.content[0];
      const callId = String(result.toolCallId);
      const call = calls.get(callId);
      calls.delete(callId);
      const view = call === undefined ? undefined : replaySubagentCall(call.name, call.arguments);
      const childSessionId = view?.mode === "background" ? continuableChildId(result.content) : undefined;
      if (view !== undefined && childSessionId !== undefined) {
        continuable.set(childSessionId, { callId, label: view.label });
      }
    } else if (event.type === "user/message" && isAppendSurfaceEvent(event)) {
      const source = event.data.source as { kind: string; senderSessionId?: unknown };
      if (source.kind === "subagent-settled" && typeof source.senderSessionId === "string") {
        continuable.delete(source.senderSessionId);
      }
    }
  }
  return continuable;
}

async function replayUpdates(args: {
  context: Context;
  sessionId: string;
  events: readonly SessionEvent[];
  /** Events of the same session that precede `events`, for correlation state older than the page. */
  priorEvents: readonly SessionEvent[];
  bindings: ReadonlyMap<string, string>;
  diagnose: (operation: string, error: unknown) => void;
}): Promise<SessionNotification[]> {
  assertKnownEvents(args.events);
  const updates: SessionNotification[] = [];
  const messageCreatedAt = new Map<string, number>();
  for (const event of args.events) {
    if (!isAssistantContentChunk(event) && event.type !== "assistant/message") continue;
    const id = `assistant:${assistantMessageId(args.sessionId, event.data.turn, event.data.step)}`;
    const time = eventTime(event);
    if (time !== undefined && !messageCreatedAt.has(id)) {
      messageCreatedAt.set(id, time);
    }
  }
  const projection: EventProjection = {
    context: args.context,
    sessionId: args.sessionId,
    mode: "replay",
    toolCalls: new Map(),
    messageCreatedAt,
    replayChildren: {
      bindings: args.bindings,
      continuable: priorContinuable(args.priorEvents),
    },
    emitUpdate: (update, messageTime, subagent) => {
      updates.push({ sessionId: args.sessionId, update, ...updateMetadata(messageTime, subagent) });
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
  readonly #bindings: SubagentBindingStore;
  readonly #sessions = new Map<SessionId, SessionRecord>();
  readonly #creations = new Set<Promise<void>>();
  readonly #loads = new Map<SessionId, Promise<void>>();
  readonly #closes = new Map<SessionId, Promise<CloseSessionResponse>>();
  readonly #children = new Map<SessionId, ChildRecord>();
  readonly #callScope = new AsyncLocalStorage<SubagentCallScope | undefined>();
  readonly #hooks: (() => void)[] = [];
  #closed = false;
  #disposal: Promise<void> | undefined;

  constructor(args: {
    context: Context;
    connection: AgentSideConnection;
    diagnostics: { write(message: string): unknown };
    bindings: SubagentBindingStore;
  }) {
    this.#context = args.context;
    this.#connection = args.connection;
    this.#diagnostics = args.diagnostics;
    this.#bindings = args.bindings;
    this.#hooks.push(this.#context.on("session/event", (session, event: SessionEvent) => {
      const record = this.#sessions.get(session.id);
      if (record?.handle.agent.session === session) {
        this.#projectEvent(record, event);
        return;
      }
      const child = this.#children.get(session.id) ?? this.#adoptDescendant(session);
      if (child?.agent.session === session) this.#projectChildEvent(child, event);
    }));
    this.#hooks.push(this.#context.on("tools/execute", (exec, next) => {
      const agent = exec.agent;
      if (agent === undefined || this.#lineageRecord(agent.id) === undefined) return next();
      const view = subagentCallView(exec.name, exec.arguments);
      // Every owned execution opens its own scope so a stale delegation scope inherited by an
      // async chain (a child's wake-up, a later `send_message`) never correlates a new start.
      return this.#callScope.run(
        view === undefined ? undefined : { callId: String(exec.callId), agentId: agent.id, view },
        next,
      );
    }));
    this.#hooks.push(this.#context.on("subagent/start", (info: SubagentRunInfo) => {
      this.#childStarted(info);
    }));
    this.#hooks.push(this.#context.on("subagent/end", (info: SubagentRunEndInfo) => {
      this.#childEnded(info);
    }));
    this.#hooks.push(this.#context.on("agent/request", async ({ agent }, next): Promise<LlmCallConfig> => {
      const resolved = await next();
      const root = this.#children.has(agent.id) ? this.#rootOf(agent.id) : undefined;
      if (root === undefined) return resolved;
      // dsh children inherit only `AgentOptions`, which owned roots never set; give descendants
      // the owning root's live selection instead so they can run at all.
      let selected: ModelSelection | undefined;
      try {
        selected = root.selection.current;
      } catch {
        return resolved;
      }
      if (selected === undefined) return resolved;
      const { reasoningEffort: _inheritedEffort, ...rest } = resolved;
      return {
        ...rest,
        provider: selected.provider,
        model: selected.model,
        ...(selected.reasoningEffort === undefined ? {} : { reasoningEffort: selected.reasoningEffort }),
      };
    }));
    this.#hooks.push(this.#context.on("agent/inbox/claimed", ({ agent, message, turn }) => {
      const inflight = this.#ownedRecord(agent)?.inflight;
      if (inflight?.messageId === String(message.id)) inflight.turn = turn;
    }));
    this.#hooks.push(this.#context.on("agent/error", ({ agent, turn }) => {
      const record = this.#ownedRecord(agent);
      const inflight = record?.inflight;
      if (record === undefined || inflight === undefined || !inflight.queued || (!inflight.command && inflight.turn !== turn)) return;
      inflight.agentError = true;
      this.#diagnostics.write(
        `sesori-deepseek-acp: session agent category=execution-failed session=${record.handle.agent.id}\n`,
      );
      inflight.terminal.resolve();
      this.#settle(record, inflight);
    }));
    this.#hooks.push(this.#context.on("commands/change", () => {
      for (const record of this.#sessions.values()) {
        record.outputTail = record.outputTail.catch(() => undefined).then(() =>
          this.#connection.sessionUpdate({
            sessionId: String(record.handle.agent.id),
            update: { sessionUpdate: "available_commands_update", availableCommands: this.#commands(record.handle.agent) },
          }),
        ).catch((error: unknown) => {
          this.#diagnose("session/commands update", record.handle.agent.id, error);
        });
      }
    }));
    this.#hooks.push(this.#context.on("approval/request", (request: ApprovalRequest, next: () => Promise<ApprovalOutcome>) => {
      const record = this.#interactiveRecord(request.agent);
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
        sessions: page.map(sessionInfo),
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
        messageCreatedAt: new Map(),
        outputTail: Promise.resolve(),
        inflight: undefined,
      };
      this.#sessions.set(sessionId, record);
      await this.#sendCommands(record);
      const configOptions = await this.#configOptions(record);
      if (this.#closed || this.#sessions.get(sessionId) !== record) {
        throw new Error("adapter ownership changed during session creation");
      }
      return { sessionId: String(sessionId), configOptions };
    } catch (error) {
      const adopted = this.#sessions.get(sessionId)?.handle === handle;
      await handle?.dispose().then(() => {
        if (adopted) this.#sessions.delete(sessionId);
      }).catch((disposeError: unknown) => {
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
        priorEvents: [],
        bindings: await this.#bindingsFor(sessionId, inspection.events),
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
          messageCreatedAt: new Map(),
          outputTail: Promise.resolve(),
          inflight: undefined,
        });
        adopted = true;
      }
      for (const update of updates) await this.#connection.sessionUpdate(update);
      const record = this.#sessions.get(sessionId);
      if (record === undefined) throw new Error("loaded session was not adopted");
      await this.#sendCommands(record, true);
      const configOptions = await this.#configOptions(record);
      if (this.#closed || this.#sessions.get(sessionId) !== record) {
        throw new Error("adapter ownership changed during session load");
      }
      return { configOptions };
    } catch (error) {
      if ((adopted || resumed) && handle !== undefined) {
        await handle.dispose().then(() => {
          if (adopted) this.#sessions.delete(sessionId);
        }).catch((disposeError: unknown) => {
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
    let loadFailure: unknown;
    if (loading !== undefined) {
      await loading.catch((error: unknown) => {
        loadFailure = error;
      });
    }
    const record = this.#sessions.get(sessionId);
    if (record === undefined) {
      if (loadFailure !== undefined) throw loadFailure;
      return {};
    }
    this.#sessions.delete(sessionId);
    try {
      await this.#disposeRecord(record);
      await this.#releaseOrphanedChildren();
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
        if (logged === undefined) {
          try {
            return defaults.currentSelection();
          } catch {
            throw new Error("default model selection unavailable");
          }
        }
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

  #sendCommands(record: SessionRecord, emitEmpty = false): Promise<void> {
    const availableCommands = this.#commands(record.handle.agent);
    if (!emitEmpty && availableCommands.length === 0) return Promise.resolve();
    return this.#connection.sessionUpdate({
      sessionId: String(record.handle.agent.id),
      update: { sessionUpdate: "available_commands_update", availableCommands },
    });
  }

  #commands(agent?: Agent): { name: string; description: string; input?: { hint: string } }[] {
    try {
      const commands = this.#context.get("commands") as
        | { list(agent: Agent): readonly { name: string; description: string; input?: { hint: string } }[] }
        | undefined;
      if (commands === undefined) throw new Error("command service is unavailable");
      // The pinned registry treats an absent scope as its global command view.
      const descriptors = commands.list(agent ?? (undefined as unknown as Agent));
      const catalogCommands = descriptors.map((command) => ({ name: command.name, description: command.description }));
      if (!validateProtocolValue({
        definition: "catalogResponse",
        value: {
          agent: { id: "deepseek", name: "DeepSeek", primary: true },
          providers: [],
          defaultSelectionId: null,
          commands: catalogCommands,
          failures: [],
        },
      }).valid) throw new Error("command catalog exceeds protocol bounds");
      return descriptors.map((command) => ({
        name: command.name,
        description: command.description,
        ...(command.input === undefined ? {} : { input: { hint: command.input.hint } }),
      }));
    } catch {
      this.#diagnostics.write("sesori-deepseek-acp: commands/list category=unavailable\n");
      return [];
    }
  }

  async #catalog(): Promise<CatalogResponse> {
    const llm = this.#context.get("llm") as Context["llm"] | undefined;
    const defaults = this.#context.get("agentDefaultModel") as
      | { currentSelection(): ModelSelection }
      | undefined;
    if (llm === undefined || defaults === undefined) throw new Error("model catalog services are unavailable");
    let descriptors: ReturnType<typeof llm.listProviders>;
    try {
      descriptors = llm.listProviders();
    } catch {
      this.#diagnostics.write("sesori-deepseek-acp: deepseek/catalog providers category=unavailable\n");
      throw new Error("DeepSeek provider catalog unavailable");
    }
    let invalidDescriptors = 0;
    const validDescriptors: typeof descriptors = [];
    for (const provider of descriptors) {
      const valid = validateProtocolValue({
        definition: "catalogResponse",
        value: {
          agent: { id: "deepseek", name: "DeepSeek", primary: true },
          providers: [{ id: provider.id, name: provider.name, models: [] }],
          defaultSelectionId: null,
          commands: [],
          failures: [],
        },
      }).valid;
      if (!valid) {
        invalidDescriptors += 1;
        continue;
      }
      validDescriptors.push(provider);
      if (validDescriptors.length === 64) break;
    }
    if (invalidDescriptors > 0) {
      this.#diagnostics.write("sesori-deepseek-acp: deepseek/catalog provider-descriptors category=invalid\n");
    }
    const providers = await Promise.all(
      validDescriptors.map(async (provider) => {
        try {
          const models = await llm.listModels(provider.id);
          if (models.length > 256) throw new Error("provider model catalog exceeds protocol bounds");
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
          const completed = { id: provider.id, name: provider.name, models: entries };
          if (!validateProtocolValue({
            definition: "catalogResponse",
            value: {
              agent: { id: "deepseek", name: "DeepSeek", primary: true },
              providers: [completed],
              defaultSelectionId: null,
              commands: [],
              failures: [],
            },
          }).valid) throw new Error("provider catalog exceeds protocol bounds");
          return { provider: completed };
        } catch {
          this.#diagnostics.write(
            `sesori-deepseek-acp: deepseek/catalog provider provider=${JSON.stringify(provider.id)} category=unavailable\n`,
          );
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
    let defaultSelectionId: string | null = null;
    try {
      defaultSelectionId = selectionId(defaults.currentSelection());
    } catch {
      this.#diagnostics.write("sesori-deepseek-acp: deepseek/catalog default-selection category=unavailable\n");
    }
    const response: CatalogResponse = {
      agent: { id: "deepseek", name: "DeepSeek", primary: true },
      providers: providers.flatMap((item) =>
        "provider" in item && item.provider.models.length > 0 ? [item.provider] : [],
      ),
      defaultSelectionId,
      commands: this.#commands().map(({ name, description }) => ({ name, description })),
      failures: providers.flatMap((item) => ("failure" in item ? [item.failure] : [])),
    };
    if (!validateProtocolValue({ definition: "catalogResponse", value: response }).valid) {
      throw new Error("DeepSeek catalog response exceeds protocol bounds");
    }
    return response;
  }

  async #configOptions(record: SessionRecord, catalog?: CatalogResponse): Promise<SessionConfigOption[]> {
    catalog ??= await this.#catalog();
    if (catalog.providers.length === 0) return [];
    const current = record.selection.current;
    if (current === undefined) throw new Error("session has no model selection");
    let selectedId: string;
    try {
      selectedId = selectionId(current);
    } catch {
      return [];
    }
    const selectedModel = catalog.providers
      .flatMap((provider) => provider.models)
      .find((model) => model.id === selectedId);
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
    const currentEffort = current.reasoningEffort ?? selectedModel?.defaultReasoningEffort;
    if (selectedModel !== undefined && currentEffort != null && selectedModel.reasoningEfforts.length > 0) {
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
    const sessionId = parseSessionId(params.sessionId);
    if (this.#loads.has(sessionId)) throw invalidParams("session load is in progress");
    const record = this.#sessions.get(sessionId);
    if (record === undefined) throw invalidParams("unknown session");
    if (record.inflight !== undefined) throw invalidParams("a prompt is in flight for this session");
    const catalog = await this.#catalog();
    if (this.#loads.has(sessionId)) throw invalidParams("session load is in progress");
    if (this.#sessions.get(sessionId) !== record) throw invalidParams("unknown session");
    if (record.inflight !== undefined) throw invalidParams("a prompt is in flight for this session");
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
    return { configOptions: await this.#configOptions(record, catalog) };
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
          priorEvents: inspection.events.filter(
            (event) => page.events[0] !== undefined && event.seq < page.events[0].seq,
          ),
          bindings: await this.#bindingsFor(sessionId, page.events),
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
    this.#assertOpen();
    const titles = this.#context.get("sessionTitle") as
      | { rename(session: Agent["session"], title: string): { title: string } }
      | undefined;
    if (titles === undefined) throw internalError("session title service is unavailable");
    const record = this.#sessions.get(sessionId);
    if (record !== undefined) {
      try {
        const renamed = titles.rename(record.handle.agent.session, params.title as string);
        if (!(await this.#flush(record.handle.agent.session))) {
          throw new Error("session persistence did not participate in rename");
        }
        await record.outputTail.catch((error: unknown) => {
          this.#diagnose("deepseek/session/rename update", sessionId, error);
        });
        return this.#renameResponse(renamed.title);
      } catch (error) {
        this.#diagnose("deepseek/session/rename", sessionId, error);
        if (error instanceof SessionTitleInvalidError) throw invalidParams("invalid DeepSeek session title");
        throw internalError("unable to rename DeepSeek session");
      }
    }
    const transition = Promise.withResolvers<void>();
    void transition.promise.catch(() => undefined);
    this.#loads.set(sessionId, transition.promise);
    let handle: AgentHandle | undefined;
    let selection: ModelSelectionRef | undefined;
    let cleanupFailure: unknown;
    let operationFailure: RequestError | undefined;
    let response: Record<string, unknown> | undefined;
    try {
      try {
        if (this.#context.agents.get(sessionId) !== undefined) {
          throw invalidParams("session is already being used outside this ACP connection");
        }
        await this.#inspect(sessionId);
        handle = await this.#context.agents.resume({
          resumeSessionId: sessionId,
          setup: (agentContext) => {
            selection = this.#installSelection(agentContext);
          },
        });
        if (this.#closed || this.#sessions.has(sessionId)) {
          throw new Error("adapter ownership changed during session rename");
        }
        const renamed = titles.rename(handle.agent.session, params.title as string);
        if (!(await this.#flush(handle.agent.session))) {
          throw new Error("session persistence did not participate in rename");
        }
        await this.#connection.sessionUpdate({
          sessionId: String(sessionId),
          update: { sessionUpdate: "session_info_update", title: renamed.title },
        }).catch((error: unknown) => {
          this.#diagnose("deepseek/session/rename update", sessionId, error);
        });
        response = this.#renameResponse(renamed.title);
      } catch (error) {
        this.#diagnose("deepseek/session/rename", sessionId, error);
        operationFailure =
          error instanceof SessionTitleInvalidError || error instanceof RequestError
            ? error instanceof SessionTitleInvalidError
              ? invalidParams("invalid DeepSeek session title")
              : error
            : internalError("unable to rename DeepSeek session");
      }
      await handle?.dispose().catch((error: unknown) => {
        cleanupFailure = error;
        this.#diagnose("deepseek/session/rename cleanup", sessionId, error);
        if (selection !== undefined && !this.#closed && !this.#sessions.has(sessionId)) {
          this.#sessions.set(sessionId, {
            handle: handle!,
            selection,
            toolCalls: new Map(),
            messageCreatedAt: new Map(),
            outputTail: Promise.resolve(),
            inflight: undefined,
          });
        }
      });
      if (cleanupFailure !== undefined) throw internalError("unable to release renamed DeepSeek session");
      if (operationFailure !== undefined) throw operationFailure;
      if (response === undefined) throw internalError("DeepSeek rename did not produce a response");
      return response;
    } finally {
      if (this.#loads.get(sessionId) === transition.promise) this.#loads.delete(sessionId);
      if (cleanupFailure === undefined) transition.resolve();
      else transition.reject(cleanupFailure);
    }
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
      if (parsed !== undefined) candidate!.images = promptImages(params.prompt);
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
          const execution = await withAbort(commands.execute(
            record.handle.agent,
            candidate!.line,
            candidate!.images,
            inflight.controller.signal,
          ), inflight.controller.signal);
          if (execution === undefined) throw new Error("advertised DeepSeek command disappeared during admission");
          inflight.endReason = { kind: "completed" };
        } catch (error) {
          if (!inflight.cancelled) {
            inflight.agentError = error;
            this.#diagnostics.write(
              `sesori-deepseek-acp: session/command session=${record.handle.agent.id} command=${JSON.stringify(parsed.name)} category=execution_failed\n`,
            );
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

  /** The owned root or registered live child an interactive request (approval, question) belongs to. */
  #interactiveRecord(agent: Agent): SessionRecord | ChildRecord | undefined {
    const root = this.#ownedRecord(agent);
    if (root !== undefined) return root;
    const child = this.#children.get(agent.id);
    return child?.agent === agent && !child.ended ? child : undefined;
  }

  #lineageRecord(id: SessionId): SessionRecord | ChildRecord | undefined {
    return this.#sessions.get(id) ?? this.#children.get(id);
  }

  /** The owned root above a registered child, following `parentSession` links through nested children. */
  #rootOf(childId: SessionId): SessionRecord | undefined {
    const visited = new Set<SessionId>();
    let cursor = this.#children.get(childId);
    while (cursor !== undefined && !visited.has(cursor.agent.id)) {
      visited.add(cursor.agent.id);
      const root = this.#sessions.get(cursor.parentId);
      if (root !== undefined) return root;
      cursor = this.#children.get(cursor.parentId);
    }
    return undefined;
  }

  /**
   * Drop a settled child once nothing below it is registered, then re-check its
   * settled ancestors: a background grandchild may outlive the child that
   * started it, and its model selection and `ended` notification still resolve
   * through that lineage.
   */
  #releaseSettled(id: SessionId): void {
    let cursor = this.#children.get(id);
    while (cursor !== undefined && cursor.ended) {
      const current = cursor;
      const descendant = [...this.#children.values()].some((child) => child.parentId === current.agent.id);
      if (descendant) return;
      this.#children.delete(current.agent.id);
      cursor = this.#children.get(current.parentId);
    }
  }

  async #releaseOrphanedChildren(): Promise<void> {
    const orphaned: ChildRecord[] = [];
    for (const [childId, child] of this.#children) {
      if (this.#rootOf(childId) !== undefined) continue;
      this.#children.delete(childId);
      orphaned.push(child);
    }
    await Promise.allSettled(orphaned.map((child) => child.outputTail));
  }

  async #bindingsFor(sessionId: SessionId, events: readonly SessionEvent[]): Promise<ReadonlyMap<string, string>> {
    if (!hasSubagentCall(events)) return new Map();
    try {
      return await this.#bindings.load({ parentId: String(sessionId) });
    } catch (error) {
      this.#diagnose("sub-agent bindings", sessionId, error);
      return new Map();
    }
  }

  /**
   * Register a live session whose `parentSession` chain reaches an owned root
   * (a descendant announced before this connection, or below a child it never
   * saw start) so its events are projected like any child's.
   */
  #adoptDescendant(session: Agent["session"]): ChildRecord | undefined {
    const agent = this.#context.agents.get(session.id);
    if (agent === undefined || agent.session !== session) return undefined;
    const chain: Agent[] = [];
    let cursor: Agent | undefined = agent;
    let parent: SessionRecord | ChildRecord | undefined;
    while (cursor !== undefined && chain.length < 16) {
      const parentId = cursor.session.header.parentSession;
      if (parentId === undefined) return undefined;
      chain.push(cursor);
      parent = this.#lineageRecord(parentId);
      if (parent !== undefined) break;
      cursor = this.#context.agents.get(parentId);
    }
    if (parent === undefined) return undefined;
    for (const descendant of chain.reverse()) {
      const record: ChildRecord = {
        agent: descendant,
        parentId: descendant.session.header.parentSession as SessionId,
        toolCalls: new Map(),
        messageCreatedAt: new Map(),
        outputTail: parent.outputTail,
        lifecycle: { kind: "unannounced" },
        ended: false,
      };
      this.#children.set(descendant.id, record);
      parent = record;
    }
    return this.#children.get(agent.id);
  }

  #childStarted(info: SubagentRunInfo): void {
    if (!info.local) return;
    const child = this.#context.agents.get(info.id);
    if (child === undefined) return;
    const scope = this.#callScope.getStore();
    const parentId = scope?.agentId ?? child.session.header.parentSession;
    if (parentId === undefined) return;
    const parent = this.#lineageRecord(parentId);
    if (parent === undefined) return;
    const existing = this.#children.get(info.id);
    const record: ChildRecord =
      existing?.agent === child
        ? existing
        : {
            agent: child,
            parentId,
            toolCalls: new Map(),
            messageCreatedAt: new Map(),
            outputTail: Promise.resolve(),
            lifecycle: { kind: "unannounced" },
            ended: false,
          };
    record.ended = false;
    record.lifecycle = { kind: "unannounced" };
    this.#children.set(info.id, record);
    // The child's first updates must follow its `started` notification.
    record.outputTail = parent.outputTail;
    if (scope === undefined || scope.agentId !== parentId) {
      // Every dsh start observed so far ran inside its delegation call; a start without one is a
      // correlation bug worth a log line, not a notification variant. The transcript still streams.
      this.#diagnose(SUBAGENT_NOTIFICATION_METHOD, parentId, new Error("sub-agent start without an executing delegation call"));
      return;
    }
    const announced = this.#notifySubagent(parent, {
      kind: "started",
      sessionId: String(parentId),
      childSessionId: String(info.id),
      toolCallId: scope.callId,
      label: scope.view.label,
      mode: scope.view.mode,
    });
    if (!announced) return;
    record.lifecycle = { kind: "announced", mode: scope.view.mode };
    record.outputTail = parent.outputTail;
    void this.#bindings
      .record({ parentId: String(parentId), toolCallId: scope.callId, childSessionId: String(info.id) })
      .catch((error: unknown) => {
        this.#diagnose("sub-agent bindings", parentId, error);
      });
  }

  #childEnded(info: SubagentRunEndInfo): void {
    const record = this.#children.get(info.id);
    if (record === undefined || record.ended) return;
    record.ended = true;
    const lifecycle = record.lifecycle;
    const parent = this.#lineageRecord(record.parentId);
    this.#releaseSettled(info.id);
    if (parent === undefined) return;
    // Every queued child update precedes its `ended` notification.
    parent.outputTail = parent.outputTail.catch(() => undefined).then(() => record.outputTail.catch(() => undefined));
    if (lifecycle.kind === "unannounced") return;
    const summary = subagentSummary(info.lastAssistantMessage);
    this.#notifySubagent(parent, {
      kind: "ended",
      sessionId: String(record.parentId),
      childSessionId: String(info.id),
      stopReason: subagentStopReason(String(info.stopReason)),
      ...(summary === undefined ? {} : { summary }),
    });
  }

  #notifySubagent(parent: SessionRecord | ChildRecord, params: Record<string, unknown>): boolean {
    const parentId = "handle" in parent ? parent.handle.agent.id : parent.agent.id;
    if (!validateProtocolValue({ definition: "subagentNotification", value: params }).valid) {
      this.#diagnose(SUBAGENT_NOTIFICATION_METHOD, parentId, new Error("sub-agent notification exceeds protocol bounds"));
      return false;
    }
    this.#queueTail(parent, () => this.#connection.extNotification(SUBAGENT_NOTIFICATION_METHOD, params));
    return true;
  }

  #queueTail(record: SessionRecord | ChildRecord, task: () => Promise<void>): void {
    if ("handle" in record) {
      this.#queue(record, task);
      return;
    }
    record.outputTail = record.outputTail.catch(() => undefined).then(task);
    void record.outputTail.catch((error: unknown) => {
      this.#diagnose("child session output", record.agent.id, error);
    });
  }

  #projectChildEvent(record: ChildRecord, event: SessionEvent): void {
    const sessionId = String(record.agent.id);
    this.#queueTail(record, () =>
      projectSessionEvent(
        {
          context: this.#context,
          sessionId,
          agent: record.agent,
          mode: "live",
          toolCalls: record.toolCalls,
          messageCreatedAt: record.messageCreatedAt,
          emitUpdate: (update, messageTime) =>
            this.#connection.sessionUpdate({ sessionId, update, ...updateMetadata(messageTime, undefined) }),
          emitStatus: (status) => this.#connection.extNotification("deepseek/session/status", status),
          diagnose: (operation, error) => this.#diagnose(operation, record.agent.id, error),
        },
        event,
      ),
    );
  }

  #queue(record: SessionRecord, task: () => Promise<void>): void {
    const inflight = record.inflight;
    record.outputTail = record.outputTail.catch(() => undefined).then(task);
    void record.outputTail.catch((error: unknown) => {
      if (inflight !== undefined) inflight.outputError ??= error;
      this.#diagnose("session output", record.handle.agent.id, error);
    });
  }

  #projectEvent(record: SessionRecord, event: SessionEvent): void {
    const sessionId = String(record.handle.agent.id);
    const project = () =>
      projectSessionEvent(
        {
          context: this.#context,
          sessionId,
          agent: record.handle.agent,
          mode: "live",
          toolCalls: record.toolCalls,
          messageCreatedAt: record.messageCreatedAt,
          emitUpdate: (update, messageTime) =>
            this.#connection.sessionUpdate({ sessionId, update, ...updateMetadata(messageTime, undefined) }),
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
      );
    if (event.type === "session/title") {
      record.outputTail = record.outputTail.catch(() => undefined).then(project).catch((error: unknown) => {
        this.#diagnose("session/title update", record.handle.agent.id, error);
      });
      return;
    }
    this.#queue(record, project);
  }

  async #flush(session: Agent["session"]): Promise<boolean> {
    const sessions = this.#context.get("sessions") as Context["sessions"] | undefined;
    return sessions !== undefined && sessions.flush(session);
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
      if (inflight.queued && !(await this.#flush(record.handle.agent.session))) {
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
    const record = this.#interactiveRecord(request.agent);
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
    const childTails = [...this.#children.values()].map((child) => child.outputTail);
    this.#sessions.clear();
    this.#children.clear();
    const outcomes = await Promise.allSettled([
      ...records.map((record) => this.#disposeRecord(record)),
      ...childTails,
    ]);
    const failures = [...transitionOutcomes, ...outcomes].flatMap((outcome) =>
      outcome.status === "rejected" ? [outcome.reason] : [],
    );
    if (failures.length === 1) throw failures[0];
    if (failures.length > 1) throw new AggregateError(failures, "failed to dispose DeepSeek sessions");
  }
}
