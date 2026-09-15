// The desktop <-> agent wire protocol, kept byte-identical to
// `apps/desktop/src/shared/agent-types.ts` in the app. The agent speaks NDJSON
// on stdio: `DesktopCommand` in on stdin, `DesktopEvent` out on stdout, one
// JSON object per line.

// ============================================================================
// Agent types (from packages/agent/src/agent/types.ts)
// ============================================================================

export enum AgentMode {
  Normal = "DEFAULT",
  AcceptEdits = "ACCEPTEDITS",
  PlanMode = "PLAN",
  /** Bypass with the kernel sandbox: no approval prompts, commands confined. */
  Auto = "AUTO",
  /** Bypass with nothing: no prompts and no sandbox. */
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
  /**
   * The same object as `input`, under the key the renderer's permission prompt
   * reads. Both are always populated until every consumer agrees on one name.
   */
  args?: Record<string, unknown>;
}

export interface ToolResult {
  id?: string;
  content: string;
  old_content?: string;
  displayContent?: string;
  rejected?: boolean;
}

export interface NotificationAction {
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
  /** Authoritative line count for a file read, after offset/limit slicing. */
  lineCount?: number;
}

export type AgentEvent =
  | { type: "status_changed"; status: AgentStatus }
  // `messageId` groups the deltas of one logical assistant message; a change
  // of id is a hard boundary, or glued messages read as one run-on paragraph.
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
  // Retire an approval prompt no one answered (expired, or abandoned on an
  // interrupt); otherwise the card outlives its call and clicks do nothing.
  | { type: "permission_cleared"; permissionId: string }
  | { type: "tool_display_data"; toolCallId: string; data: ToolDisplayData }
  | { type: "tool_output_update"; toolCallId: string; output: string }
  | { type: "tool_user_message"; toolCallId: string; message: string }
  | {
      type: "mode_changed";
      mode: AgentMode;
      /**
       * Who moved it. "startup" echoes what the spawn was told; "user" acks a
       * change the UI asked for; "approval" is the agent moving itself, the
       * one case a UI must follow. "bot" is any of those inside a bot
       * conversation, whose mode is pinned and must never read as a user
       * preference.
       */
      source: "startup" | "user" | "approval" | "bot";
    }
  | { type: "model_changed"; model: string }
  // Whether this session's shell commands run under a kernel sandbox, sent
  // once at startup; `reason` says why not.
  | {
      type: "turn_complete";
      /**
       * What the provider charged for the turn's last request. Cached tokens
       * falling to zero mid-session is a prompt prefix that changed.
       */
      usage?: {
        input: number;
        output: number;
        cacheRead: number;
        cacheWrite: number;
        requests: number;
        model: string | null;
      };
    }
  // Brackets around a delegated sub-agent's work: text between them belongs to
  // the sub-agent's card, not the main thread. `kind` and `status` are optional
  // so a renderer that predates them keeps working; absent `status` means
  // 'completed'.
  | { type: "subtask_start"; id: string; description?: string; kind?: string }
  | { type: "subtask_end"; id: string; status?: "completed" | "failed" }
  | { type: "user_message_dequeued"; content: string }
  /**
   * A message sent mid-turn reached the model as a user message at a step
   * boundary; the desktop shows it in the transcript at that point.
   */
  | { type: "user_message_steered"; content: string }
  | {
      type: "error";
      // The error payload is inconsistent across models: text may be at
      // `message`, only at `segmentData.message`, or absent. Read defensively.
      error: {
        message?: string;
        code?: string;
        name?: string;
        segmentData?: { message?: string; type?: string; [k: string]: unknown };
        /**
         * What the provider itself said, when `message` is the app's reading
         * of it. For the log, never the screen: a report of "the model
         * provider had a problem (400)" is undiagnosable without the sentence
         * the provider actually sent.
         */
        detail?: string;
        /** `upgrade-abacus` renders the upgrade card instead of the error. */
        actions?: Array<{ type: string; link?: string }>;
      };
    }
  | {
      type: "notification";
      message: string;
      severity: "info" | "warning" | "error" | "success";
      actions?: NotificationAction[];
      /**
       * A notification carrying a key overwrites the last one with the same
       * key instead of appending, so rate-limited model fallbacks read as one
       * line.
       */
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

// ============================================================================
// Permission types (from packages/agent/src/providers/types.ts)
// ============================================================================

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
      /** Hidden credential stores the command names; approving unhides them. */
      credentialPaths?: string[];
    })
  | (PermissionRequestBase & {
      type: "browser_action";
      action: string;
      url?: string;
      description: string;
    })
  | (PermissionRequestBase & {
      // Egress: the model picks the whole URL and a query string can carry
      // anything the agent has read, so the card shows the URL in full.
      type: "fetch_url";
      url: string;
      origin: string;
    })
  | (PermissionRequestBase & {
      // A confined command reached for a host nobody listed; the connection
      // waits on the answer.
      type: "network_host";
      host: string;
      port: number;
    })
  | (PermissionRequestBase & {
      // The sandbox refused what a command tried; allowing runs it again.
      type: "sandbox_denied";
      command: string;
      denials: Array<
        | { kind: "read"; path: string }
        | { kind: "write"; path: string }
        | { kind: "host"; host: string; port: number }
      >;
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

// ============================================================================
// Skill types
// ============================================================================

export interface SkillMetadata {
  id: string;
  name: string;
  description: string;
  location: string;
}

// ============================================================================
// NDJSON Protocol types (ndjson IPC host <-> desktop app)
// ============================================================================

/**
 * A message the user sent while a turn was running, and what it is waiting
 * for: `step` lands at pi's next step boundary, `permission` is parked until
 * the pending prompt is answered, `turn` runs as the next turn.
 */
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
 * Services the desktop process performs on behalf of a tool in the agent
 * process. A closed list: each one needs Electron, not a general escape hatch.
 * The `render_*` services own the markup, stylesheet and page geometry, so a
 * caller supplies content and choices and cannot produce a document, design or
 * deck that fails to lay out; the catalog services (`document_templates`,
 * `design_catalog`, `deck_templates`, `deck_slots`) describe what is available
 * without ever exposing the markup.
 */
export type HostService =
  | "render_document"
  | "document_templates"
  | "design_catalog"
  | "render_design"
  | "deck_templates"
  | "deck_slots"
  | "render_deck";

/** Events sent from ndjson IPC host to main process (stdout) */
export type DesktopEvent =
  // `agentSessionId` and `agentSessionFile` identify the log pi writes for this
  // conversation; without them nothing on disk connects the desktop's session
  // to the turn-by-turn record.
  | {
      type: "ready";
      model: string;
      mode: string;
      agentSessionId?: string;
      agentSessionFile?: string;
    }
  | { type: "event"; event: AgentEvent }
  // Proof the agent is alive while a tool runs: the desktop times a turn out
  // when nothing arrives, and a quiet build is indistinguishable from a wedged
  // agent. Out-of-band rather than an AgentEvent because it is liveness for the
  // host, not something the transcript should show.
  | { type: "heartbeat"; runningTools: number }
  // A service only the desktop app can perform, requested by a tool in this
  // process and answered with `host_service_response` carrying the same
  // `requestId`: how a component reaches Chromium without living behind an MCP
  // hop. Same correlated request/reply pattern as `permission_needed`.
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
