/**
 * Agent domain types, vendored type-only for the renderer from the agent
 * package, which is not a dependency of this app. Value enums are re-expressed
 * as literal unions plus `declare`d shapes, so this module emits nothing. If
 * an upstream shape changes, re-extract rather than hand-patching.
 */

// ─── tools/tool-codec.ts ─────────────────────────────────────────────────────

/**
 * Ambient mirror of the agent package's `REJECTION_REASON` enum; used only in
 * type position, so it emits no JavaScript.
 */
export declare enum REJECTION_REASON {
  USER_MESSAGE = "user_message",
  REJECTED = "rejected",
  INTERRUPTED = "interrupted",
}

// ─── agent/errors.ts ─────────────────────────────────────────────────────────

export type AgentErrorCode = number | string;

/** Structural stand-in for the agent package's `AgentError` class. */
export interface AgentError extends Error {
  readonly retryable: boolean;
  readonly code?: AgentErrorCode;
  readonly cause?: Error;
}

// ─── agent/stream-events.ts ──────────────────────────────────────────────────

export type StreamEvent =
  | {
      type: "terminal_command";
      cmdline: string;
      output: string;
      toolCallId?: string;
      subtaskId?: string;
      /**
       * Output so far from a command that is still running. Without it the
       * reducer settles the card on the first byte as if it had finished.
       */
      streaming?: boolean;
    }
  | {
      type: "file_write_start";
      filepath: string;
      command?: string;
      toolCallId?: string;
      isNewFile?: boolean;
      subtaskId?: string;
    }
  | {
      type: "file_write_progress";
      filepath: string;
      contentChunk: string;
      toolCallId?: string;
      subtaskId?: string;
    }
  | {
      type: "file_write_done";
      filepath: string;
      toolCallId?: string;
      isNewFile?: boolean;
      subtaskId?: string;
    }
  | {
      type: "file_read";
      filepath: string;
      readRange?: string;
      toolCallId?: string;
      subtaskId?: string;
    }
  | {
      type: "web_search_results";
      query: string;
      resultType: "web" | "image";
      results: WebSearchResult[];
      subtaskId?: string;
    }
  | { type: "media"; media: GeneratedMedia; subtaskId?: string }
  | {
      type: "feature_limit";
      featureName: string;
      limitType: string;
      subtaskId?: string;
    }
  | {
      type: "file";
      action: "new" | "overwrite" | "edit";
      filepath: string;
      content?: string;
      diff?: string;
      toolCallId?: string;
      isNewFile?: boolean;
      subtaskId?: string;
    };

export interface WebSearchResult {
  title: string;
  url: string;
  snippet?: string;
  thumbnailUrl?: string;
}

export type GeneratedMedia =
  | {
      kind: "image";
      url: string;
      width: number;
      height: number;
      prompt?: string;
      model?: string;
    }
  | {
      kind: "video";
      url: string;
      width: number;
      height: number;
      prompt?: string;
      model?: string;
      aspectRatio?: string;
      duration?: number;
      loop: boolean;
    };

// ─── agent/types.ts ──────────────────────────────────────────────────────────

/**
 * Upstream a value `enum`; vendored as a union plus a `declare const` so both
 * type and value positions keep working with no emitted code.
 */
export type PermissionMode = "DEFAULT" | "ACCEPTEDITS" | "PLAN" | "YOLO";

export declare const PermissionMode: {
  readonly Normal: "DEFAULT";
  readonly AcceptEdits: "ACCEPTEDITS";
  /**
   * Plan mode: the finished plan comes back for approval via the
   * `exit_plan_mode` round-trip, whose decision picks the next mode.
   */
  readonly PlanMode: "PLAN";
  readonly Yolo: "YOLO";
};

/** Upstream this is a value `enum`; see the note on {@link PermissionMode}. */
export type AgentStatus =
  | "idle"
  | "submitted"
  | "streaming"
  | "executing-tool"
  | "waiting-for-tool-permission"
  | "loading-conversation";

export declare const AgentStatus: {
  readonly Idle: "idle";
  readonly Submitted: "submitted";
  readonly Streaming: "streaming";
  readonly ExecutingTool: "executing-tool";
  readonly WaitingForToolPermission: "waiting-for-tool-permission";
  readonly LoadingConversation: "loading-conversation";
};

export interface ToolCallBase<
  TName extends string,
  TArgs extends Record<string, unknown>,
> {
  id: string;
  name: TName;
  args: TArgs;
  status: ToolCallStatus;
  /** Wire endpoint retained only for dispatching server-requested local tools. */
  endpoint?: string;
}

export interface BashToolArgs extends Record<string, unknown> {
  command?: string;
  timeout?: number;
  run_in_background?: boolean;
  runInBackground?: boolean;
}

export interface FileToolArgs extends Record<string, unknown> {
  path?: string;
  file_path?: string;
  filePath?: string;
  filepath?: string;
  command?: string;
  content?: string;
  file_text?: string;
  old_str?: string;
  new_str?: string;
  insert_line?: number;
  start_line?: number;
  end_line?: number;
  limit?: number;
  pages?: string;
}

export type ServerToolArgs = Record<string, unknown>;

export interface McpToolArgs extends Record<string, unknown> {
  server_id?: string;
  serverId?: string;
  tool_name?: string;
  toolName?: string;
  arguments?: Record<string, unknown>;
}

export type KnownToolCallName =
  | "bash"
  | "grep"
  | "glob"
  | "read"
  | "write"
  | "edit"
  | "think"
  | "todo_write"
  | "web_search_text_only"
  | "scrape_url_content"
  | "generate_image"
  | "generate_video"
  | "stop"
  | "perform_subtask_explore"
  | "perform_subtask_plan"
  | "perform_subtask_general_purpose";

export interface ToolArgsByName {
  bash: BashToolArgs;
  grep: ServerToolArgs;
  glob: ServerToolArgs;
  read: FileToolArgs;
  write: FileToolArgs;
  edit: FileToolArgs;
  think: ServerToolArgs;
  todo_write: ServerToolArgs;
  web_search_text_only: ServerToolArgs;
  scrape_url_content: ServerToolArgs;
  generate_image: ServerToolArgs;
  generate_video: ServerToolArgs;
  stop: ServerToolArgs;
  perform_subtask_explore: ServerToolArgs;
  perform_subtask_plan: ServerToolArgs;
  perform_subtask_general_purpose: ServerToolArgs;
}

export type KnownToolCall = {
  [TName in KnownToolCallName]: ToolCallBase<TName, ToolArgsByName[TName]>;
}[KnownToolCallName];

export type McpToolCall = ToolCallBase<string, McpToolArgs> & {
  endpoint: "mcp_call";
};

/** Escape variant for tools not known by this client version. */
export type UnknownToolCall = ToolCallBase<string, Record<string, unknown>>;

/** Canonical tool call emitted after backend request rectification. */
export type ToolCall = KnownToolCall | McpToolCall | UnknownToolCall;

export type ToolCallStatus =
  | "pending"
  | "executing"
  | "awaiting_permission"
  | "success"
  | "error"
  | "rejected"
  | "interrupted"
  | "skipped"
  | "abandoned";

export interface ReadToolResultData {
  type: "read";
  content: string;
  startLine?: number;
  lineCount: number;
  isUploadedDocument?: boolean;
  filePath?: string;
  filename?: string;
  size?: number;
  mimeType?: string;
}

export interface FileMutationToolResultData {
  type: "file_mutation";
  originalContent?: string;
  finalContent?: string;
  diff?: string;
  isNewFile?: boolean;
  additions?: number;
  deletions?: number;
}

export interface BashToolResultData {
  type: "bash";
  command: string;
  output: string;
  exitCode?: number;
  duration?: number;
  background?: boolean;
  terminated?: boolean;
  timedOut?: boolean;
}

export interface McpToolResultData {
  type: "mcp";
  content: string;
  isError: boolean;
}

export interface GenericToolResultData {
  type: "generic";
  output: string;
}

export type ToolResultData =
  | ReadToolResultData
  | FileMutationToolResultData
  | BashToolResultData
  | McpToolResultData
  | GenericToolResultData;

export interface ToolRejection {
  reason: "rejected" | "interrupted" | "sibling_failed";
  userMessage?: string;
}

/** Canonical stored tool result owned by the agent domain. */
export interface ToolResult<TData extends ToolResultData = ToolResultData> {
  toolCallId: string;
  output: string;
  error?: string;
  rejection?: ToolRejection;
  data?: TData;
}

export interface NotificationAction {
  type: string;
  link?: string;
}

/** Branch-version navigation for a bot turn with sibling regenerations/edits. */
export interface SegmentVersions {
  /** 1-based. */
  current: number;
  total: number;
  siblings: { messageIndex: number; regenerateAttempt: number }[];
}

export type ConversationSegment =
  | {
      type: "text";
      id: string;
      source: "user" | "bot";
      content: string;
      /** Backend turn ordinal (conversation_sequence_number), when known. */
      messageIndex?: number;
      /** Sibling-version index of the turn (0 = original). */
      regenerateAttempt?: number;
      /** Present on the last bot turn only. */
      versions?: SegmentVersions;
    }
  | {
      type: "thinking";
      id: string;
      content: string;
      title?: string;
      isSpinny: boolean;
    }
  | {
      // Generic foldaway segment: title always shown, body only when expanded.
      type: "collapsible";
      id: string;
      title?: string;
      content: string;
      isSpinny: boolean;
    }
  | {
      type: "tool_call";
      id: string;
      toolCall: ToolCall;
      toolResult?: ToolResult;
    }
  | {
      type: "notification";
      id: string;
      message: string;
      severity: "info" | "warning" | "error" | "success";
      actions?: NotificationAction[];
      /** See the loop event below: notices that overwrite one line. */
      notificationKey?: string;
    }
  | {
      type: "tool_group";
      id: string;
      tools: ConversationSegment[];
      category: string;
      summary: string;
    }
  | {
      // Per-turn credits marker, rendered inline between turns on resume.
      type: "credits";
      id: string;
      creditsUsed: number;
    }
  | {
      type: "web_search_results";
      id: string;
      query: string;
      resultType: "web" | "image";
      results: WebSearchResult[];
    }
  | { type: "media"; id: string; media: GeneratedMedia }
  | {
      type: "feature_limit";
      id: string;
      featureName: string;
      limitType: string;
    }
  | { type: "compaction"; id: string; summary: string }
  | {
      // Sub-agent bracket reconstructed on resume from `super_agent_task`
      // created/completed frames (docs/deep-agent-sse.md §9); `id` is the
      // created frame's messageId.
      type: "subtask";
      id: string;
      status: "created" | "completed";
      description?: string;
      // How the bracket ended; an omitted frame alone cannot tell
      // "interrupted" from "still running" or "close lost".
      outcome?: "completed" | "interrupted";
    };

export type AgentEvent =
  | { type: "status_changed"; status: AgentStatus }
  // A change of `messageId` is a hard message boundary; consumers must not
  // glue content across it. `subtaskId` tags text streamed inside a sub-agent
  // bracket, which belongs to that scope and not the main thread.
  | {
      type: "text_delta";
      content: string;
      messageId?: string;
      subtaskId?: string;
    }
  | {
      type: "thinking_delta";
      content: string;
      title?: string;
      subtaskId?: string;
    }
  | { type: "thinking_complete" }
  | {
      type: "collapsible";
      title?: string;
      content: string;
      isSpinny: boolean;
      subtaskId?: string;
    }
  // Canonical plan state (wire: `super_agent_todos`); replaces the list wholesale.
  | {
      type: "todos";
      todos: {
        id: string;
        content: string;
        status: "pending" | "in_progress" | "completed";
      }[];
    }
  | { type: "tool_result"; toolCall: ToolCall; result: ToolResult }
  | { type: "tool_output_update"; toolCallId: string; output: string }
  | { type: "tool_user_message"; toolCallId: string; message: string }
  | { type: "mode_changed"; mode: PermissionMode }
  | { type: "turn_complete" }
  | { type: "user_message_dequeued"; content: string }
  | { type: "user_message_steered"; content: string }
  | { type: "error"; error: AgentError }
  | {
      type: "notification";
      message: string;
      severity: "info" | "warning" | "error" | "success";
      actions?: NotificationAction[];
      /**
       * A notification carrying a key overwrites the last one with the same
       * key instead of being appended.
       */
      notificationKey?: string;
      [key: string]: unknown;
    }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      isNetworkError: boolean;
    }
  | { type: "network_status"; online: boolean }
  | { type: "credits"; creditsUsed: number }
  /** @deprecated ndjson island only — remove with the island */
  | {
      type: "session_info";
      contextPercent: number;
      contextTokensUsed: number;
      contextWindowMax: number;
    }
  | { type: "conversation_info"; conversationId: string; title?: string }
  | { type: "spinner"; title: string; active: boolean }
  | {
      type: "web_search_results";
      query: string;
      resultType: "web" | "image";
      results: WebSearchResult[];
      subtaskId?: string;
    }
  | { type: "media"; media: GeneratedMedia; subtaskId?: string }
  | {
      type: "feature_limit";
      featureName: string;
      limitType: string;
      subtaskId?: string;
    }
  | { type: "compaction"; summary: string }
  // Sub-agent brackets. The server loop delimits a subtask only positionally
  // (docs/deep-agent-sse.md §9); the rectifier synthesizes a stable `id` that
  // nested work events carry as `subtaskId`.
  | { type: "subtask_start"; id: string; description?: string }
  | { type: "subtask_end"; id: string }
  // Permission lifecycle, emitted via the `onPermissionEvent` side-channel and
  // not interleaved into the send() stream; `conversationId` keys the store.
  | {
      type: "permission_request";
      conversationId: string;
      toolId: string;
      request: PermissionRequest;
      alwaysAllowRules?: string[];
    }
  | { type: "permission_cleared"; conversationId: string; toolId: string };

/** The subset of {@link AgentEvent} delivered through the permission side-channel. */
export type PermissionAgentEvent = Extract<
  AgentEvent,
  { type: "permission_request" | "permission_cleared" }
>;

// ─── providers/types.ts ──────────────────────────────────────────────────────

export type PermissionDecision =
  | "accept"
  | "reject"
  | "allowAlways"
  | "allowYolo"
  | { type: "accept_with_message"; message: string }
  | { type: "reject_with_message"; message: string }
  /** Live: server-loop askUserQuestion. */
  | { type: "question_answers"; answers: Record<string, string> }
  | { type: "allow_always_with_rules"; rules: string[] };

/** Live: server-loop askUserQuestion. */
export type AskUserQuestionItem = {
  question: string;
  header: string;
  options: Array<{ label: string; description: string }>;
  multiSelect: boolean;
};

interface PermissionRequestBase {
  tool: ToolCall;
  /** Display name from the tool definition, e.g. "Edit". */
  displayName: string;
}

export type PermissionRequest =
  | (PermissionRequestBase & {
      type: "edit_file";
      filePath: string;
      originalContent: string;
      newContent: string;
      diffShownInEditor?: boolean;
    })
  | (PermissionRequestBase & {
      type: "write_file";
      filePath: string;
      originalContent: string;
      content: string;
      isNewFile: boolean;
      diffShownInEditor?: boolean;
    })
  | (PermissionRequestBase & {
      type: "run_terminal";
      command: string;
      cwd: string;
      background: boolean;
      unmatchedPatterns: string[];
      /** Hidden credential stores the command names; approving unhides them. */
      credentialPaths?: string[];
    })
  | (PermissionRequestBase & {
      type: "generic";
      toolName: string;
      inputSummary: string;
    })
  /** Live: server-loop askUserQuestion. */
  | (PermissionRequestBase & {
      type: "ask_user_question";
      questions: AskUserQuestionItem[];
    })
  /** Live: plan-mode approval round-trip. */
  | (PermissionRequestBase & {
      type: "exit_plan_mode";
      planFilePath: string;
      planContent: string;
    })
  | (PermissionRequestBase & {
      type: "write_outside_directory";
      filePath: string;
      resolvedPath: string;
      deducedDirectory: string;
      isNewFile: boolean;
    })
  | (PermissionRequestBase & {
      type: "edit_outside_directory";
      filePath: string;
      resolvedPath: string;
      deducedDirectory: string;
    });

// ─── storage/types.ts ────────────────────────────────────────────────────────

/**
 * A shadow-git snapshot anchored to a point in the conversation; the mapping
 * the client keeps so it can offer "rewind to this message".
 */
export interface CheckpointEntry {
  /** Also the shadow ref suffix. */
  id: string;
  /** Shadow-repo commit hash the snapshot resolves to. */
  commit: string;
  /**
   * Backend turn ordinal this was taken before; the durable anchor, since
   * client segment ids are ephemeral. Absent until the backend acknowledges.
   */
  messageIndex?: number;
  createdAt: string;
  /** E.g. the first line of the user prompt. */
  label?: string;
}

// ─── agent/session-config.ts ─────────────────────────────────────────────────

export type MessageQueueEntry = {
  id: string;
  message: string;
  hidden?: true;
  /**
   * What a mid-turn message waits on; absent on transports that only queue
   * for the next turn.
   */
  waitingFor?: "step" | "permission" | "turn";
};

// ─── agent/agent-loop.ts (type only) ─────────────────────────────────────────

export type AgentLoopEvent =
  | AgentEvent
  | StreamEvent
  | { type: "network_status"; online: boolean }
  // A checkpoint was captured for the turn about to run; clients record the
  // messageIndex→commit mapping to offer rewind.
  | { type: "checkpoint_captured"; checkpoint: CheckpointEntry }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      isNetworkError: boolean;
    }
  | {
      type: "tool_call";
      toolCall: ToolCall;
      subtaskId?: string;
      /**
       * Set for a playground file write, whose backend emits no `file_write
       * status:done` frame; the runner emits `file_write_done` itself, only on
       * successful completion so rejection never finalizes the card.
       */
      finalizeFileWriteOnSuccess?: boolean;
    };
