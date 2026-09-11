// The wire protocol between the app and the agent process. Mirrored verbatim
// at packages/agent/src/protocol.ts; change both together.

export enum AgentMode {
  Normal = "DEFAULT",
  AcceptEdits = "ACCEPTEDITS",
  PlanMode = "PLAN",
  Yolo = "YOLO",
}

export enum AgentStatus {
  Idle = "idle",
  Submitted = "submitted",
  Streaming = "streaming",
  ExecutingTool = "executing-tool",
  WaitingForToolPermission = "waiting-for-tool-permission",
  LoadingConversation = "loading-conversation",
}

export interface ToolRequest {
  id: string;
  name: string;
  type: string;
  input: Record<string, unknown>;
  /** Same object as `input`; the permission prompt reads this key. Both always set. */
  args?: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  content: string;
  old_content?: string;
  displayContent?: string;
  rejected?: boolean;
}

interface NotificationAction {
  type: string;
  link?: string;
}

export interface StreamingNestedToolCall {
  id: string;
  name: string;
  input: Record<string, unknown>;
  status: "executing" | "success" | "error";
}

export type ConversationSegment =
  | {
      type: "text";
      id: string;
      source: "user" | "bot";
      content: string;
    }
  | {
      type: "thinking";
      id: string;
      content: string;
      title?: string;
      isSpinny: boolean;
    }
  | {
      type: "tool_call";
      id: string;
      toolUseRequest: ToolRequest;
      toolUseResult?: ToolResult;
      toolPhase: string;
      parsedResult?: unknown;
      toolDisplayData?: ToolDisplayData;
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
    };

export interface ToolDisplayData {
  originalContent?: string;
  newContent?: string;
  finalContent?: string;
  streamingOutput?: string;
  isPlanFile?: boolean;
  isNewFile?: boolean;
  additions?: number;
  deletions?: number;
  toolCallCount?: number;
  nestedToolCalls?: StreamingNestedToolCall[];
  /** Authoritative line count for a file read (respects offset/limit slicing). */
  lineCount?: number;
}

export type AgentEvent =
  | { type: "status_changed"; status: AgentStatus }
  // A change of `messageId` is a hard boundary: the renderer must start a new
  // text segment, since no chunk carries a separator.
  | { type: "text_delta"; content: string; messageId?: string }
  | { type: "thinking_delta"; content: string; title?: string }
  | { type: "thinking_complete" }
  | { type: "tool_call_start"; toolCallId: string; toolName: string }
  | { type: "tool_call_delta"; toolCallId: string; argumentsDelta: string }
  | {
      type: "tool_call_stop";
      toolCallId: string;
      toolName: string;
      arguments: string;
    }
  | { type: "tool_requested"; tool: ToolRequest }
  | { type: "tool_execution_start"; tool: ToolRequest }
  | { type: "tool_execution_complete"; tool: ToolRequest; result: ToolResult }
  | { type: "permission_needed"; tool: ToolRequest; permissionId: string }
  // Retire an approval prompt nobody answered (expired, or the turn was
  // interrupted); otherwise the card outlives its call and clicking does nothing.
  | { type: "permission_cleared"; permissionId: string }
  | { type: "tool_display_data"; toolCallId: string; data: ToolDisplayData }
  | { type: "tool_output_update"; toolCallId: string; output: string }
  | { type: "tool_user_message"; toolCallId: string; message: string }
  | {
      type: "mode_changed";
      mode: AgentMode;
      /**
       * Who moved it. Only "approval" (the agent moving itself) is a change a
       * UI must follow; "startup" echoes the spawn, "user" acks the UI's own
       * request, and "bot" is a bot's pinned mode, never a user preference.
       */
      source: "startup" | "user" | "approval" | "bot";
    }
  | { type: "model_changed"; model: string }
  | {
      type: "turn_complete";
      /** The turn's last request; cache reads falling to zero mean the prefix changed. */
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        requests: number;
        model: string | null;
      };
    }
  // Authorship boundary: text between these belongs to the sub-agent's card,
  // not the main thread. `kind` and `status` are optional for older renderers;
  // an absent `status` means 'completed'.
  | { type: "subtask_start"; id: string; description?: string; kind?: string }
  | { type: "subtask_end"; id: string; status?: "completed" | "failed" }
  | { type: "user_message_dequeued"; content: string }
  | { type: "user_message_steered"; content: string }
  | {
      type: "error";
      // Inconsistent across models: the text may be at `message`, only at
      // `segmentData.message`, or absent. Read defensively.
      error: {
        message?: string;
        code?: string;
        name?: string;
        /** The provider's own sentence, for the log rather than the screen. */
        detail?: string;
        segmentData?: {
          message?: string;
          type?: string;
          [k: string]: unknown;
          actions?: Array<{ type: string; link?: string }>;
        };
      };
    }
  | {
      type: "notification";
      message: string;
      severity: "info" | "warning" | "error" | "success";
      actions?: NotificationAction[];
      /** A keyed notice overwrites the last with the same key instead of appending. */
      notificationKey?: string;
      [key: string]: unknown;
    }
  | {
      type: "conversation_loaded";
      conversationId: string;
      title?: string;
      segments: ConversationSegment[];
    }
  | { type: "segment_updated"; segment: ConversationSegment }
  | { type: "segments_cleared" }
  | {
      type: "retry";
      attempt: number;
      maxAttempts: number;
      delayMs: number;
      isNetworkError: boolean;
    }
  | { type: "network_status"; online: boolean }
  | {
      type: "credits";
      creditsUsed: number;
      counter?: number;
      messageId?: string;
    };

// Permission types (from packages/agent/src/providers/types.ts)

export type PermissionDecision =
  | "accept"
  | "reject"
  | "background"
  | "allowAlways"
  | "allowYolo"
  | { type: "accept_with_message"; message: string }
  | { type: "reject_with_message"; message: string }
  | { type: "question_answers"; answers: Record<string, string> }
  | { type: "allow_always_with_rule"; rule: string }
  | { type: "allow_always_with_rules"; rules: string[] };

interface PermissionRequestBase {
  tool: ToolRequest;
  displayName: string;
}

export type PermissionRequest =
  | (PermissionRequestBase & {
      type: "edit_file";
      filePath: string;
      originalContent: string;
      newContent: string;
      diffContent?: string;
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
      type: "delete";
      filePath: string;
    })
  | (PermissionRequestBase & {
      type: "run_terminal";
      command: string;
      cwd: string;
      background: boolean;
      unmatchedPatterns?: string[];
    })
  | (PermissionRequestBase & {
      type: "browser_action";
      action: string;
      url?: string;
      description: string;
    })
  | (PermissionRequestBase & {
      // Egress: a query string can carry anything the agent has read, so the
      // card shows the URL in full.
      type: "fetch_url";
      url: string;
      origin: string;
    })
  | (PermissionRequestBase & {
      type: "generic";
      toolName: string;
      inputSummary: string;
    })
  | (PermissionRequestBase & {
      type: "exit_plan_mode";
      planFilePath: string;
      planContent: string;
    })
  | (PermissionRequestBase & {
      type: "ask_user_question";
      questions: Array<{
        question: string;
        header: string;
        options: Array<{ label: string; description: string }>;
        multiSelect: boolean;
      }>;
    })
  | (PermissionRequestBase & {
      type: "read_outside_directory";
      filePath: string;
      resolvedPath: string;
      deducedDirectory: string;
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
    })
  | (PermissionRequestBase & {
      type: "notebook_edit_outside_directory";
      filePath: string;
      resolvedPath: string;
      deducedDirectory: string;
    })
  | (PermissionRequestBase & {
      type: "notebook_edit";
      notebookPath: string;
      cellId?: string;
      editMode: "replace" | "insert" | "delete";
      cellType?: "code" | "markdown";
      originalContent: string;
      newContent: string;
    });

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
}

// NDJSON protocol types (ndjson IPC host <-> desktop app)

/** A message sent mid-turn and what it is waiting for. */
export interface QueueEntry {
  id: string;
  message: string;
  hidden?: true;
  waitingFor: "step" | "permission" | "turn";
}

/** Commands sent from main process to ndjson IPC host (stdin) */
export type DesktopCommand =
  | {
      type: "send";
      message: string;
      conversationId?: string;
      activeSkills?: string[];
    }
  | { type: "stop" }
  | { type: "set_mode"; mode: string }
  | { type: "set_model"; model: string }
  | {
      type: "permission_response";
      permissionId: string;
      decision: PermissionDecision;
    }
  | { type: "switch_conversation"; conversationId: string }
  | { type: "reset_conversation" }
  | { type: "list_skills" }
  | { type: "enqueue"; message: string; hidden: boolean }
  | { type: "dequeue" }
  | { type: "get_queue" }
  | { type: "clear_queue" }
  | { type: "remove_from_queue"; index: number }
  | { type: "update_queue_item"; index: number; message: string }
  | { type: "mcp_list_servers" }
  /** Re-read stored API keys and provider catalogs without restarting. */
  | { type: "refresh_providers" }
  | { type: "mcp_refresh" }
  | { type: "mcp_restart_server"; serverId: string }
  | {
      type: "host_service_response";
      requestId: string;
      ok: boolean;
      result?: unknown;
      error?: string;
    }
  | { type: "mcp_get_server_logs"; serverId: string };

type CliMcpStatus =
  | "connecting"
  | "connected"
  | "error"
  | "auth-required"
  | "disconnected";

type CliMcpLogLevel =
  | "raw"
  | "debug"
  | "info"
  | "notice"
  | "warning"
  | "error"
  | "critical"
  | "alert"
  | "emergency";

export interface CliMcpServerSnapshot {
  id: string;
  name: string;
  transport: string;
  status: CliMcpStatus;
  error?: string;
  authUrl?: string;
  pid?: number;
  connectedAt?: string;
  updatedAt?: string;
  toolCount: number;
}

export interface CliMcpLogEntry {
  serverId: string;
  source: "notification" | "stderr" | "transport";
  level: CliMcpLogLevel;
  logger?: string;
  line: string;
  ts: string;
}

export interface CliMcpStatusEvent {
  serverId: string;
  status: CliMcpStatus;
  error?: string;
  authUrl?: string;
  pid?: number;
  ts: string;
}

/**
 * Services the desktop process performs for a tool in the agent process. A
 * closed list: each genuinely needs Electron. The `*_templates`, `*_catalog`
 * and `deck_slots` services describe templates and slots, never markup; the
 * `render_*` services own the markup and stylesheets, so a caller supplies
 * content and cannot produce a document that fails to lay out.
 */
export type HostService =
  | "render_document"
  | "document_templates"
  | "design_catalog"
  | "render_design"
  | "deck_templates"
  | "deck_slots"
  | "render_deck";

/** Events sent from ndjson IPC host to main process (stdout). */
export type DesktopEvent =
  // Session id and log path are optional: an older agent build omits them.
  | {
      type: "ready";
      model: string;
      mode: string;
      agentSessionId?: string;
      agentSessionFile?: string;
    }
  | { type: "event"; event: AgentEvent }
  // Proof the agent is alive while a tool runs; consumed by the turn watchdog,
  // never forwarded. An older agent build never sends it.
  | { type: "heartbeat"; runningTools: number }
  // Answered by `host_service_response` with the same `requestId`: how a tool
  // reaches Chromium without living in the desktop process behind an MCP hop.
  | {
      type: "host_service_request";
      requestId: string;
      service: HostService;
      payload: unknown;
    }
  | {
      type: "permission_needed";
      permissionId: string;
      request: PermissionRequest;
    }
  | { type: "skills_loaded"; skills: SkillMetadata[] }
  | {
      type: "queue_updated";
      messages: QueueEntry[];
      dequeued?: string | null;
    }
  | { type: "mcp_servers"; servers: CliMcpServerSnapshot[] }
  | ({ type: "mcp_server_status" } & CliMcpStatusEvent)
  | ({ type: "mcp_server_log" } & CliMcpLogEntry)
  | { type: "mcp_server_logs"; serverId: string; entries: CliMcpLogEntry[] }
  | { type: "mcp_refresh_failed"; error: string }
  | { type: "mcp_restart_failed"; serverId: string; error: string };
