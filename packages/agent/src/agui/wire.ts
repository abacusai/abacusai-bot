/**
 * The `--wire agui` protocol (spec 00-agent-agui §2). Types only.
 *
 * stdout carries one AG-UI event per line, line 1 always `CUSTOM wire.hello`.
 * The compatibility stream (fd 3, or inline behind a U+001E byte) carries
 * today's NDJSON `DesktopEvent` lines byte for byte. stdin accepts every
 * legacy `DesktopCommand` plus the three control commands below.
 */
import type {
  EventType,
  Event as AguiCoreEvent,
  Interrupt as AguiInterrupt,
  RunAgentInput as AguiRunAgentInput,
} from "@ag-ui/core";

import type {
  AgentMode,
  AgentStatus,
  CliMcpLogEntry,
  CliMcpServerSnapshot,
  DesktopCommand,
  NotificationAction,
  PermissionDecision,
  PermissionRequest,
  QueueEntry,
  SkillMetadata,
  ToolDisplayData,
} from "../protocol.js";
import type { TurnUsage } from "../turn-usage.js";

// ---------------------------------------------------------------- commands

/** Everything stdin accepts under --wire agui. */
export type AgentCommand = DesktopCommand | AguiControlCommand;

export type AguiControlCommand =
  /** A turn from the renderer's chat client. Sent only when the thread is idle (§3.1.6). */
  | { type: "run"; input: RunInput }
  /**
   * Stop the reply in flight. With `runId`: applied only if that run, or the
   * admission that will open it, is current; otherwise ignored. Without it:
   * unconditional, like the legacy `stop`.
   */
  | { type: "cancel"; runId?: string }
  /** Answer one permission, independently of any other (§3.5). */
  | {
      type: "permission.respond";
      lineage: PermissionLineage;
      decision: PermissionDecision;
    };

/** AG-UI RunAgentInput as the SubscribeConnectionAdapter sends it. `resume` must be absent or empty. */
export type RunInput = Omit<AguiRunAgentInput, "forwardedProps"> & {
  forwardedProps?: {
    /** Applied during turn preparation when it differs; same path as set_mode. */
    mode?: string;
    /** Applied (awaited) during turn preparation when it differs; same path as set_model. */
    model?: string;
    /** Accepted and ignored: the legacy host drops send.activeSkills too. */
    activeSkills?: string[];
    /** Accepted and ignored; must equal threadId when present. */
    conversationId?: string;
    /** "regenerate": an explicit request to answer the newest user message again. */
    intent?: "send" | "regenerate";
  };
};

/** Identifies the exact pending permission an answer is for (§3.5.3). */
export interface PermissionLineage {
  threadId: string;
  /** From wire.hello / session.ready / the descriptor; new per agent process. */
  incarnation: string;
  /** The TurnToken seq of the send that owned the permission when raised. */
  turnSeq: number;
  /** The run open when it was raised, if any. Informational; not validated. */
  runId?: string;
  /** perm-N from the descriptor. */
  permissionId: string;
}

// ------------------------------------------------------------------ events

/** The event types this agent emits. */
export type EmittedType =
  | EventType.RUN_STARTED
  | EventType.RUN_FINISHED
  | EventType.RUN_ERROR
  | EventType.TEXT_MESSAGE_START
  | EventType.TEXT_MESSAGE_CONTENT
  | EventType.TEXT_MESSAGE_END
  | EventType.REASONING_START
  | EventType.REASONING_MESSAGE_START
  | EventType.REASONING_MESSAGE_CONTENT
  | EventType.REASONING_MESSAGE_END
  | EventType.REASONING_END
  | EventType.TOOL_CALL_START
  | EventType.TOOL_CALL_ARGS
  | EventType.TOOL_CALL_END
  | EventType.TOOL_CALL_RESULT
  | EventType.STATE_SNAPSHOT
  | EventType.STATE_DELTA
  | EventType.CUSTOM
  | EventType.SUBAGENT_STARTED
  | EventType.SUBAGENT_FINISHED
  | EventType.SUBAGENT_ERROR;

/** Every stdout line: a canonical @ag-ui/core event of an emitted type. */
export type AguiEvent = Extract<AguiCoreEvent, { type: EmittedType }>;

/** RUN_FINISHED: outcome is "success" or "cancelled"; never "interrupt". */
export interface RunFinishedMeta {
  tanstack?: { model?: string; finishReason?: "stop" | "length" | null };
  abacus?: {
    turnUsage?: TurnUsage;
    stopReason?: PiStopReason;
    serverInitiated?: true;
  };
}

/** RUN_ERROR: threadId/runId ride in metadata.tanstack (TanStack's convention). */
export interface RunErrorMeta {
  tanstack: { threadId: string; runId: string; model?: string };
  abacus: { error: AgentErrorPayload; turnUsage?: TurnUsage };
}

export type PiStopReason =
  | "pending"
  | "stop"
  | "length"
  | "toolUse"
  | "error"
  | "aborted"
  | "deferred";

/** Today's AgentEvent error payload, verbatim. */
export interface AgentErrorPayload {
  message?: string;
  code?: string;
  name?: string;
  segmentData?: { message?: string; type?: string; [k: string]: unknown };
  detail?: string;
  actions?: NotificationAction[];
}

/** TOOL_CALL_START metadata. Only facts that never change after START. */
export interface ToolCallStartMeta {
  abacus: {
    /** pi's own tool name before TOOL_NAME_ALIASES; toolCallName is the display name. */
    rawName: string;
    /** The legacy id when it differs from the AG-UI id (child calls). */
    legacyToolCallId?: string;
  };
}

/** TOOL_CALL_END metadata: canonical parsed input. */
export interface ToolCallEndMeta {
  tanstack: { input: Record<string, unknown> };
}

/** TOOL_CALL_RESULT metadata; the error fields make StreamProcessor mark the part as an error. */
export interface ToolCallResultMeta {
  tanstack?: {
    state: "output-error";
    toolResultOutcome?: "denied" | "cancelled";
  };
}

/** TOOL_CALL_RESULT content is JSON.stringify(ToolResultContent). */
export interface ToolResultContent {
  /** Byte-identical to today's ToolResult.content. */
  text: string;
  /** Today's ToolResult.rejected (event.isError). */
  rejected: boolean;
  /** Set only when rejected, equal to `text`, so TanStack's toolResultErrorText shows it. */
  error?: string;
  display?: ToolDisplayData;
  terminal?: { output: string };
  /** vendored formatToolContent() markdown. */
  formatted?: string;
  /** The run closed the call without a result. */
  unfinished?: true;
}

export interface PlanItem {
  content: string;
  status: "pending" | "in_progress" | "completed";
}

export interface AgentState {
  mode: AgentMode;
  modeSource: "startup" | "user" | "approval" | "bot";
  model: string;
  agentSessionId?: string;
  agentSessionFile?: string;
  incarnation: string;
  /** Present only after the first successful `todo` set; normalized as stored. */
  plan?: PlanItem[];
}

/** Permission descriptor: an AG-UI Interrupt carried in CUSTOM, never in a RUN_FINISHED outcome. */
export interface PermissionDescriptor extends AguiInterrupt {
  id: string;
  reason: "abacus:permission" | "abacus:question";
  message: string;
  toolCallId?: string;
  subagentRunId?: string;
  expiresAt?: string;
  metadata: {
    abacus: {
      lineage: PermissionLineage;
      kind: PermissionRequest["type"];
      request: PermissionRequest;
      attachedBy: "gate" | "command-match" | "sole-running" | "none";
      /** Decisions the widget may send for this kind. */
      allowed: DecisionKind[];
    };
  };
}

export type DecisionKind =
  | "accept"
  | "reject"
  | "background"
  | "allowAlways"
  | "allowYolo"
  | "accept_with_message"
  | "reject_with_message"
  | "question_answers"
  | "allow_always_with_rule"
  | "allow_always_with_rules";

export type CompatMode = "fd" | "inline" | "none";

export type RunAckStatus = "started" | "queued" | "duplicate" | "rejected";

export type RunAckReason =
  | "regenerate_unsupported"
  | "empty"
  | "resume_unsupported"
  /** `input.threadId` or `forwardedProps.conversationId` is not this process's thread. */
  | "thread_mismatch";

export type ResponseRejectedReason =
  | "incarnation"
  | "thread"
  | "turn"
  | "not_pending"
  | "invalid_decision"
  | "decision_not_allowed";

/** Every CUSTOM name and its value. Nothing else is emitted. */
export interface CustomValues {
  "session.ready": {
    model: string;
    mode: string;
    agentSessionId?: string;
    agentSessionFile?: string;
    incarnation: string;
  };
  "session.cleared": Record<string, never>;
  "wire.hello": {
    protocol: 1;
    wire: "agui";
    compat: CompatMode;
    incarnation: string;
  };
  "wire.compat_lost": { error: string };
  "agent.status": { status: AgentStatus };
  "agent.heartbeat": { runningTools: number };
  "agent.error": AgentErrorPayload;
  "agent.notification": Record<string, unknown> & {
    message: string;
    severity: "info" | "warning" | "error" | "success";
  };
  "agent.retry": {
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    isNetworkError: boolean;
  };
  "run.ack": {
    runId: string;
    status: RunAckStatus;
    entryId?: string;
    waitingFor?: QueueEntry["waitingFor"];
    reason?: RunAckReason;
  };
  "permission.requested": PermissionDescriptor;
  "permission.resolved": {
    permissionId: string;
    decisionKind: DecisionKind;
    source: "respond" | "legacy_response";
  };
  "permission.cleared": {
    permissionId: string;
    reason: "expired" | "stopped" | "reset";
  };
  "permission.response_rejected": {
    lineage: unknown;
    reason: ResponseRejectedReason;
  };
  "permission.pending": { incarnation: string; items: PermissionDescriptor[] };
  "tool.output": { toolCallId: string; output: string };
  "tool.display": { toolCallId: string; data: ToolDisplayData };
  "queue.updated": { messages: QueueEntry[]; dequeued: string | null };
  "queue.steered": { content: string };
  "queue.dequeued": { content: string };
  "skills.loaded": { skills: SkillMetadata[] };
  "mcp.servers": { servers: CliMcpServerSnapshot[] };
  "mcp.server_logs": { serverId: string; entries: CliMcpLogEntry[] };
}

export type CustomName = keyof CustomValues;
