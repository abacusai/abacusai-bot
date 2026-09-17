/**
 * Browser-safe conversation domain shared by the CLI and extension. Imports
 * from the agent package are type-only: the package never pulls Node APIs into
 * a renderer bundle.
 */
import type {
  AgentLoopEvent,
  AgentStatus,
  ConversationSegment,
  MessageQueueEntry,
  NotificationAction,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
  BashToolResultData,
  FileMutationToolResultData,
  GenericToolResultData,
  KnownToolCall,
  KnownToolCallName,
  McpToolCall,
  McpToolResultData,
  ReadToolResultData,
  ToolCall,
  ToolResult,
  ToolResultData,
  ToolCallStatus,
  CheckpointEntry,
  SegmentVersions,
} from "./agent-types";

export type { SegmentVersions };

// ─── Status ──────────────────────────────────────────────────────────────────

export type ConversationStatus = `${AgentStatus}`;
export type ConversationPermissionMode = `${PermissionMode}`;

// ─── Segments ────────────────────────────────────────────────────────────────

export type SegmentStatus = "transient" | "completed";
export type SegmentSource = "user" | "bot";
export type NotificationSeverity = "info" | "warning" | "error" | "success";

export interface UserAttachment {
  filename: string;
  mimeType: string;
}

interface SegmentBase {
  id: string;
  status: SegmentStatus;
  source: SegmentSource;
  /**
   * Backend turn ordinal shared by every segment of one turn. Stable across
   * reloads, unlike `id`, so it anchors edit, rewind and checkpoint restore.
   * Undefined for locally-echoed segments until the backend acknowledges.
   */
  messageIndex?: number;
  /** Which sibling version of the turn this is (0 = original). */
  regenerateAttempt?: number;
  /** Branch-version navigation data (present on the last bot turn only). */
  versions?: SegmentVersions;
  /** Id of the open subtask bracket this segment was produced under. */
  subtaskId?: string;
}

export type TextSegment = SegmentBase & {
  type: "text";
  content: string;
  attachments?: UserAttachment[];
};

export type ThinkingSegment = SegmentBase & {
  type: "thinking";
  content: string;
  title?: string;
  isSpinny: boolean;
  thinkingStartTime?: number;
  thinkingEndTime?: number;
};

export type CollapsibleSegment = SegmentBase & {
  type: "collapsible";
  content: string;
  title?: string;
  isSpinny: boolean;
  temp?: boolean;
};

type KnownToolCallFor<TName extends KnownToolCallName> = Extract<
  KnownToolCall,
  { name: TName }
>;

export interface ToolResultDataByName {
  bash: BashToolResultData;
  grep: GenericToolResultData;
  glob: GenericToolResultData;
  read: ReadToolResultData;
  write: FileMutationToolResultData;
  edit: FileMutationToolResultData;
  think: GenericToolResultData;
  todo_write: GenericToolResultData;
  web_search_text_only: GenericToolResultData;
  scrape_url_content: GenericToolResultData;
  generate_image: GenericToolResultData;
  generate_video: GenericToolResultData;
  stop: GenericToolResultData;
  perform_subtask_explore: GenericToolResultData;
  perform_subtask_plan: GenericToolResultData;
  perform_subtask_general_purpose: GenericToolResultData;
}

type SpecializedToolName = "bash" | "read" | "write" | "edit";
type GenericToolName = Exclude<KnownToolCallName, SpecializedToolName>;

type SpecializedTool = {
  [TName in SpecializedToolName]: {
    kind: "known";
    call: KnownToolCallFor<TName>;
    result?: ToolResult<ToolResultDataByName[TName]>;
  };
}[SpecializedToolName];

type GenericKnownTool = {
  kind: "known";
  call: Extract<KnownToolCall, { name: GenericToolName }>;
  result?: ToolResult<GenericToolResultData>;
};

export type KnownTool = SpecializedTool | GenericKnownTool;

type KnownToolFor<TName extends KnownToolCallName> =
  TName extends SpecializedToolName
    ? Extract<SpecializedTool, { call: { name: TName } }>
    : {
        kind: "known";
        call: KnownToolCallFor<TName>;
        result?: ToolResult<GenericToolResultData>;
      };

export type McpTool = {
  kind: "mcp";
  call: McpToolCall;
  result?: ToolResult<McpToolResultData>;
};

/** Escape variant for a tool unknown to this client version. */
export type UnknownTool = {
  kind: "unknown";
  call: ToolCall;
  result?: ToolResult;
};

/** One renderer-ready tool shape shared by every product. */
export type Tool = KnownTool | McpTool | UnknownTool;

function copyToolResult<TData extends ToolResultData>(
  result: ToolResult,
  data: TData | undefined
): ToolResult<TData> {
  return {
    toolCallId: result.toolCallId,
    output: result.output,
    ...(result.error !== undefined && { error: result.error }),
    ...(result.rejection !== undefined && { rejection: result.rejection }),
    ...(data !== undefined && { data }),
  };
}

function isKnownToolCall(call: ToolCall): call is KnownToolCall {
  return call.endpoint !== "callMcpTool" && KNOWN_TOOL_NAMES.has(call.name);
}

function isMcpToolCall(call: ToolCall): call is McpToolCall {
  return call.endpoint === "callMcpTool";
}

/**
 * Build a renderer tool, degrading mismatched result data to unknown. Keep the
 * `as Tool` assertions: this app compiles with `strictNullChecks` off, so the
 * `result.data.type` guards no longer narrow and each branch would fail to
 * match the `Tool` union. The assertions only restore that narrowing.
 */
export function createTool(call: ToolCall, result?: ToolResult): Tool {
  if (isMcpToolCall(call)) {
    if (result?.data !== undefined && result.data.type !== "mcp") {
      return { kind: "unknown", call, result };
    }
    return {
      kind: "mcp",
      call,
      ...(result !== undefined && {
        result: copyToolResult(result, result.data),
      }),
    } as Tool;
  }

  if (!isKnownToolCall(call)) {
    return { kind: "unknown", call, ...(result !== undefined && { result }) };
  }

  switch (call.name) {
    case "bash":
      if (result?.data !== undefined && result.data.type !== "bash") break;
      return {
        kind: "known",
        call,
        ...(result !== undefined && {
          result: copyToolResult(result, result.data),
        }),
      } as Tool;
    case "read":
      if (result?.data !== undefined && result.data.type !== "read") break;
      return {
        kind: "known",
        call,
        ...(result !== undefined && {
          result: copyToolResult(result, result.data),
        }),
      } as Tool;
    case "write":
      if (result?.data !== undefined && result.data.type !== "file_mutation")
        break;
      return {
        kind: "known",
        call,
        ...(result !== undefined && {
          result: copyToolResult(result, result.data),
        }),
      } as Tool;
    case "edit":
      if (result?.data !== undefined && result.data.type !== "file_mutation")
        break;
      return {
        kind: "known",
        call,
        ...(result !== undefined && {
          result: copyToolResult(result, result.data),
        }),
      } as Tool;
    case "grep":
    case "glob":
    case "think":
    case "todo_write":
    case "web_search_text_only":
    case "scrape_url_content":
    case "generate_image":
    case "generate_video":
    case "stop":
    case "perform_subtask_explore":
    case "perform_subtask_plan":
    case "perform_subtask_general_purpose":
      if (result?.data !== undefined && result.data.type !== "generic") break;
      return {
        kind: "known",
        call,
        ...(result !== undefined && {
          result: copyToolResult(result, result.data),
        }),
      } as Tool;
  }

  return { kind: "unknown", call, ...(result !== undefined && { result }) };
}

export type ToolLifecycleStatus =
  | "running"
  | "success"
  | "error"
  | "rejected"
  | "interrupted"
  | "skipped"
  | "abandoned";

export type ToolRenderStatus = Exclude<ToolCallStatus, "awaiting_permission">;

export function isTool<TName extends KnownToolCallName>(
  tool: Tool,
  name: TName
): tool is KnownToolFor<TName> {
  return tool.kind === "known" && tool.call.name === name;
}

export function isMcpTool(tool: Tool): tool is McpTool {
  return tool.kind === "mcp";
}

export function getToolLifecycleStatus(tool: Tool): ToolLifecycleStatus {
  if (tool.call.status === "abandoned") return "abandoned";
  if (
    tool.result?.rejection?.reason === "interrupted" ||
    tool.call.status === "interrupted"
  ) {
    return "interrupted";
  }
  if (
    tool.result?.rejection?.reason === "rejected" ||
    tool.call.status === "rejected"
  ) {
    return "rejected";
  }
  if (
    tool.result?.rejection?.reason === "sibling_failed" ||
    tool.call.status === "skipped"
  ) {
    return "skipped";
  }
  if (tool.result?.error !== undefined || tool.call.status === "error")
    return "error";
  if (
    tool.call.status === "pending" ||
    tool.call.status === "executing" ||
    tool.call.status === "awaiting_permission"
  ) {
    return "running";
  }
  return "success";
}

/** A canonical, renderer-ready tool call and its eventual canonical result. */
export type ToolCallSegment = SegmentBase & {
  type: "tool_call";
  tool: Tool;
};

export type NotificationSegment = SegmentBase & {
  type: "notification";
  message: string;
  severity: NotificationSeverity;
  actions?: NotificationAction[];
  flashKey?: number;
  /** A keyed notice overwrites the line already holding the key. */
  notificationKey?: string;
};

export type CreditsSegment = SegmentBase & {
  type: "credits";
  creditsUsed: number;
};

interface NativeToolSegmentBase extends SegmentBase {
  /** Carried by native stream events before dispatch metadata is attached. */
  toolCallId?: string;
  tool: Tool;
}

export type TerminalCommandSegment = NativeToolSegmentBase & {
  type: "terminal_command";
  cmdline: string;
  cmdOutput: string;
};

export type FileWriteSegment = NativeToolSegmentBase & {
  type: "file_write";
  filepath: string;
  fileWriteDone: boolean;
  fileWriteCommand?: string;
  fileWriteIsNewFile?: boolean;
  fileWriteBuffer?: string;
  fileTail?: string[];
  fileDiff?: string;
};

export type FileReadSegment = NativeToolSegmentBase & {
  type: "file_read";
  filepath: string;
  readRange?: string;
};

export type PendingSegment = NativeToolSegmentBase & {
  type: "pending";
  filepath?: string;
  fileWriteCommand?: string;
  cmdline?: string;
};

export type CompactionSegment = SegmentBase & {
  type: "compaction";
  compactionSummary: string;
};

export type WebSearchResultsSegment = SegmentBase & {
  type: "web_search_results";
  query: string;
  resultType: "web" | "image";
  results: import("./agent-types").WebSearchResult[];
};

export type MediaSegment = SegmentBase & {
  type: "media";
  media: import("./agent-types").GeneratedMedia;
};

export type FeatureLimitSegment = SegmentBase & {
  type: "feature_limit";
  featureName: string;
  limitType: string;
};

// A failed bracket settles as `interrupted`: no separate `failed`, since a
// reader sees the same fact and persistence only records "did not finish".
export type SubtaskStatus = "running" | "completed" | "interrupted";

// Optional everywhere: older hosts and persisted transcripts send no kind.
export type SubtaskKind = "component" | "delegate" | "browser";
/** Why a finished sub-agent is not a plain success; absent when it is. */
export type SubtaskOutcome = "needs-user" | "limit" | "budget";

// Child segments with `subtaskId === subtaskRef` render inside the card. Live
// sessions only: hydrated history has no bracket data and stays inline.
export type SubtaskSegment = SegmentBase & {
  type: "subtask";
  /** Bracket id that child segments carry as their `subtaskId`. */
  subtaskRef: string;
  description?: string;
  subtaskKind?: SubtaskKind;
  subtaskStatus: SubtaskStatus;
  subtaskOutcome?: SubtaskOutcome;
  subtaskStartTime?: number;
  subtaskEndTime?: number;
};

export type Segment =
  | TextSegment
  | ThinkingSegment
  | CollapsibleSegment
  | ToolCallSegment
  | NotificationSegment
  | CreditsSegment
  | TerminalCommandSegment
  | FileWriteSegment
  | FileReadSegment
  | PendingSegment
  | WebSearchResultsSegment
  | MediaSegment
  | FeatureLimitSegment
  | CompactionSegment
  | SubtaskSegment;

export type ToolSegment =
  | ToolCallSegment
  | TerminalCommandSegment
  | FileWriteSegment
  | FileReadSegment
  | PendingSegment;

export const TOOL_DISPLAY_NAMES: Readonly<Record<KnownToolCallName, string>> = {
  bash: "Bash",
  grep: "Grep",
  glob: "Glob",
  read: "Read",
  write: "Write",
  edit: "Edit",
  think: "Think",
  todo_write: "TodoWrite",
  web_search_text_only: "WebSearch",
  scrape_url_content: "Fetch",
  generate_image: "GenerateImage",
  generate_video: "GenerateVideo",
  stop: "Stop",
  perform_subtask_explore: "Explore",
  perform_subtask_plan: "Plan",
  perform_subtask_general_purpose: "GeneralPurpose",
};

const KNOWN_TOOL_NAMES = new Set<string>(Object.keys(TOOL_DISPLAY_NAMES));

export function isKnownToolName(name: string): name is KnownToolCallName {
  return KNOWN_TOOL_NAMES.has(name);
}

// Stripped for display only: `agent-tools_ppt` would title-case into
// "AgentToolsPpt". Host and agent still match tools by the real name.
const DISPLAY_NAME_PREFIXES = ["agent-tools_"];

/** Display names for the builtin components, whose bases title-case badly. */
const COMPONENT_DISPLAY_NAMES: Readonly<Record<string, string>> = {
  pdf: "PDF",
  ppt: "Slides",
  app: "App",
  design: "Design",
  deck_export_pdf: "Export PDF",
};

export function getToolDisplayName(name: string): string {
  if (isKnownToolName(name)) return TOOL_DISPLAY_NAMES[name];
  const prefix = DISPLAY_NAME_PREFIXES.find((candidate) =>
    name.startsWith(candidate)
  );
  const bare = prefix === undefined ? name : name.slice(prefix.length);
  const component = COMPONENT_DISPLAY_NAMES[bare];
  if (component !== undefined) return component;
  return bare
    .split(/[_-]+/)
    .filter(Boolean)
    .map((part) => part[0]?.toUpperCase() + part.slice(1))
    .join("");
}

// ─── Events ──────────────────────────────────────────────────────────────────

export interface ConversationErrorPayload {
  message: string;
  actions?: NotificationAction[];
}

export type ConversationLoopEvent =
  // Permission events travel as the `{ kind: "permission" }` envelope, never
  // inside a loop event. The subtask brackets are re-declared because the local
  // host adds two optional extras (kind, failure) the server loop lacks.
  | Exclude<
      AgentLoopEvent,
      {
        type:
          | "error"
          | "permission_request"
          | "permission_cleared"
          | "subtask_start"
          | "subtask_end";
      }
    >
  | { type: "error"; error: ConversationErrorPayload }
  | {
      type: "subtask_start";
      id: string;
      description?: string;
      kind?: SubtaskKind;
    }
  | {
      type: "subtask_end";
      id: string;
      status?: "completed" | "failed";
      outcome?: SubtaskOutcome;
    }
  // `/clear` inside the agent; same semantics as the `{ kind: "reset" }` envelope.
  | { type: "segments_cleared" };

export interface PermissionPrompt {
  request: PermissionRequest;
  alwaysAllowRules?: string[];
}

export type ConversationEvent =
  | { kind: "event"; event: ConversationLoopEvent; receivedAt?: number }
  | {
      kind: "hydrate";
      segments: ConversationSegment[];
      title?: string;
      /** Persisted checkpoint mapping to seed ConversationState.checkpoints. */
      checkpoints?: CheckpointEntry[];
    }
  | { kind: "user_message"; content: string; attachments?: UserAttachment[] }
  // What a messaging turn sent, shown in place of the turn's withheld text.
  | { kind: "agent_message"; content: string }
  | { kind: "permission"; prompt: PermissionPrompt | null }
  | { kind: "queue"; entries: MessageQueueEntry[] }
  | { kind: "retract_user_message" }
  | { kind: "reset" };

// ─── Reducer state ───────────────────────────────────────────────────────────

export interface RetryState {
  attempt: number;
  maxAttempts: number;
  delayMs: number;
  isNetworkError: boolean;
}

export interface SubtaskInfo {
  id: string;
  description?: string;
  kind?: SubtaskKind;
}

export interface ConversationInternalState {
  generation: number;
  counter: number;
  /** Id of the open subtask bracket, or null when not inside a subtask. */
  activeSubtaskId: string | null;
  turn: {
    textSegmentId: string | null;
    /**
     * Wire message id streaming into `textSegmentId`. A delta with a different
     * id must start a new segment: no chunk carries a separator, so gluing
     * across the boundary corrupts markdown.
     */
    textMessageId: string | null;
    thinkingSegmentId: string | null;
    toolCallIds: string[];
    pendingCredits: number;
    /**
     * Keyed notification lines this turn wrote, key → segment id. Per turn,
     * not per transcript: keys restart at 1 with each agent process, so a
     * transcript-wide match would rewrite a line from days ago.
     */
    notificationKeys: Record<string, string>;
  };
}

export interface ConversationState {
  segments: Segment[];
  status: ConversationStatus;
  title: string | null;
  queuedMessages: MessageQueueEntry[];
  pendingPermission: PermissionPrompt | null;
  retry: RetryState | null;
  online: boolean;
  credits: number;
  spinner: string | null;
  error: ConversationErrorPayload | null;
  /** Sub-agent registry from `subtask_start`/`subtask_end` brackets. */
  subtasks: Record<string, SubtaskInfo>;
  /**
   * The server-loop plan (wire: `super_agent_todos`), replaced wholesale per
   * event. When non-empty it wins over the local `todo_write` segment scan.
   */
  serverTodos: {
    id: string;
    content: string;
    status: "pending" | "in_progress" | "completed";
  }[];
  /**
   * Checkpoints captured this session, newest last; `messageIndex` joins each
   * to its turn. The persisted list lives in LocalProjectStore.
   */
  checkpoints: CheckpointEntry[];
  internal: ConversationInternalState;
}

// ─── Typed command transport ─────────────────────────────────────────────────

export type ConversationAttachment =
  | { kind: "data"; filename: string; mimeType: string; base64Data: string }
  | { kind: "path"; filePath: string }
  | {
      kind: "document";
      documentId: string;
      filename?: string;
      mimeType?: string;
    };

export interface SendMessageOptions {
  model?: string;
  includeEditorContext?: boolean;
  hidden?: boolean;
  /**
   * Regenerate the last assistant turn as a sibling branch. With `editPrompt`
   * the last user message is edited in place first and `text` is the new prompt.
   */
  regenerate?: boolean;
  editPrompt?: boolean;
}

export interface QueueOptions {
  includeHidden?: boolean;
}

export interface DequeueOptions extends QueueOptions {
  id?: string;
}

export interface StopProcessingResult {
  dequeuedMessage: string | null;
}

/** Commands implemented by a CLI AgentSession or an extension oRPC adapter. */
export interface ConversationCommandTransport {
  sendMessage(
    conversationId: string | null,
    text: string,
    attachments?: ConversationAttachment[],
    options?: SendMessageOptions
  ): Promise<void>;
  stopProcessing(conversationId: string | null): Promise<StopProcessingResult>;
  respondToPermission(
    conversationId: string | null,
    toolCallId: string,
    decision: PermissionDecision
  ): Promise<void>;
  enqueueMessage(
    conversationId: string | null,
    text: string,
    options?: { hidden?: boolean }
  ): Promise<void>;
  dequeueMessages(
    conversationId: string | null,
    options?: DequeueOptions
  ): Promise<void>;
  sendQueuedMessage(conversationId: string | null, id: string): Promise<void>;
  removeQueuedMessage(
    conversationId: string | null,
    id: string,
    options?: QueueOptions
  ): Promise<void>;
  updateQueuedMessage(
    conversationId: string | null,
    id: string,
    text: string
  ): Promise<void>;
  clearQueue(
    conversationId: string | null,
    options?: QueueOptions
  ): Promise<void>;
  selectConversation(conversationId: string | null): Promise<void>;
  createConversation(): Promise<string>;
  deleteConversation(conversationId: string): Promise<void>;
  renameConversation(conversationId: string, title: string): Promise<void>;
  /** Feedback on the latest assistant turn. Optional: the extension has no entry point. */
  submitConversationFeedback?(
    conversationId: string,
    feedback: string
  ): Promise<void>;
  loadMoreConversations(offset: number): Promise<void>;
  refreshConversations(): Promise<void>;
  setModel(model: string): Promise<void>;
  setPermissionMode(mode: ConversationPermissionMode): Promise<void>;
  clearConversation(conversationId: string | null): Promise<void>;

  // Editing / branch versions / rewind. Optional until an app wires them; each
  // mutates the backend then re-hydrates, so the UI reflects authoritative history.
  selectVersion?(
    conversationId: string | null,
    messageIndex: number,
    targetRegenerateAttempt: number
  ): Promise<void>;
  editResponse?(
    conversationId: string | null,
    messageIndex: number,
    text: string
  ): Promise<void>;
  /** Delete `messageIndex` (a user turn) and everything after it. */
  truncateToMessage?(
    conversationId: string | null,
    messageIndex: number
  ): Promise<void>;
  restoreCheckpoint?(
    conversationId: string | null,
    checkpoint: CheckpointEntry
  ): Promise<void>;
  reloadHistory?(conversationId: string | null): Promise<void>;
}

export interface ConversationTransport extends ConversationCommandTransport {
  subscribe(
    cb: (conversationId: string, event: ConversationEvent) => void
  ): () => void;
}

/** The provider's stable command methods; reducer dispatch is absent. */
export interface ConversationCommands {
  sendMessage: (
    text: string,
    attachments?: ConversationAttachment[],
    options?: SendMessageOptions
  ) => Promise<void>;
  stopProcessing: () => Promise<StopProcessingResult>;
  respondToPermission: (decision: PermissionDecision) => Promise<void>;
  enqueueMessage: (
    text: string,
    options?: { hidden?: boolean }
  ) => Promise<void>;
  dequeueMessages: (options?: DequeueOptions) => Promise<void>;
  sendQueuedMessage: (id: string) => Promise<void>;
  removeQueuedMessage: (id: string, options?: QueueOptions) => Promise<void>;
  updateQueuedMessage: (id: string, text: string) => Promise<void>;
  clearQueue: (options?: QueueOptions) => Promise<void>;
  selectConversation: (conversationId: string | null) => Promise<void>;
  createConversation: () => Promise<string>;
  deleteConversation: (conversationId: string) => Promise<void>;
  renameConversation: (conversationId: string, title: string) => Promise<void>;
  submitConversationFeedback?: (
    conversationId: string,
    feedback: string
  ) => Promise<void>;
  loadMoreConversations: (offset: number) => Promise<void>;
  refreshConversations: () => Promise<void>;
  setModel: (model: string) => Promise<void>;
  setPermissionMode: (mode: ConversationPermissionMode) => Promise<void>;
  clearConversation: () => Promise<void>;

  // Optional until the active transport implements them.
  selectVersion?: (
    messageIndex: number,
    targetRegenerateAttempt: number
  ) => Promise<void>;
  editResponse?: (messageIndex: number, text: string) => Promise<void>;
  truncateToMessage?: (messageIndex: number) => Promise<void>;
  restoreCheckpoint?: (checkpoint: CheckpointEntry) => Promise<void>;
  reloadHistory?: () => Promise<void>;
}
