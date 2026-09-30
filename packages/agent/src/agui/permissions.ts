/**
 * Permissions on AG-UI (spec §3.5): independent descriptors carried in CUSTOM
 * events, answered one at a time by `permission.respond`, with the answer's
 * lineage checked before anything reaches the session. No native interrupts.
 */
import type { PermissionDecision, PermissionRequest } from "../protocol.js";
import { nativeId } from "./ids.js";
import type {
  DecisionKind,
  PermissionDescriptor,
  PermissionLineage,
  ResponseRejectedReason,
} from "./wire.js";

const FILE_KINDS: DecisionKind[] = [
  "accept",
  "reject",
  "allowAlways",
  "allowYolo",
  "accept_with_message",
  "reject_with_message",
];

const SANDBOX_KINDS: DecisionKind[] = [
  "accept",
  "accept_with_message",
  "background",
  "allowAlways",
  "allow_always_with_rule",
  "allow_always_with_rules",
  "allowYolo",
  "reject",
  "reject_with_message",
];

/** The decisions a widget may send for a request kind (§3.5.2). */
export function allowedDecisions(
  kind: PermissionRequest["type"]
): DecisionKind[] {
  switch (kind) {
    case "run_terminal":
      return [
        ...FILE_KINDS,
        "background",
        "allow_always_with_rule",
        "allow_always_with_rules",
      ];
    case "exit_plan_mode":
      return [...FILE_KINDS];
    case "ask_user_question":
      return ["question_answers", "reject"];
    case "sandbox_denied":
    case "network_host":
      return [...SANDBOX_KINDS];
    default:
      return [...FILE_KINDS];
  }
}

const isStringRecord = (value: unknown): value is Record<string, string> =>
  value != null &&
  typeof value === "object" &&
  !Array.isArray(value) &&
  Object.values(value).every((entry) => typeof entry === "string");

/**
 * Strict structural validation against the `PermissionDecision` union.
 * Anything else (a boolean, `{approved}`) is invalid, never coerced to reject.
 */
export function isPermissionDecision(
  value: unknown
): value is PermissionDecision {
  if (typeof value === "string") {
    return (
      value === "accept" ||
      value === "reject" ||
      value === "background" ||
      value === "allowAlways" ||
      value === "allowYolo"
    );
  }

  if (value == null || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(",");

  switch (record.type) {
    case "accept_with_message":
    case "reject_with_message":
      return keys === "message,type" && typeof record.message === "string";
    case "question_answers":
      return keys === "answers,type" && isStringRecord(record.answers);
    case "allow_always_with_rule":
      return keys === "rule,type" && typeof record.rule === "string";
    case "allow_always_with_rules":
      return (
        keys === "rules,type" &&
        Array.isArray(record.rules) &&
        record.rules.every((rule) => typeof rule === "string")
      );
    default:
      return false;
  }
}

export function decisionKind(decision: PermissionDecision): DecisionKind {
  return typeof decision === "string" ? decision : decision.type;
}

/** One pending permission as the host mirrors it. */
export interface PendingPermission {
  descriptor: PermissionDescriptor;
  turnSeq: number;
}

/** What a running tool call looks like to `attachToolCall`. */
export interface RunningCall {
  /** AG-UI id. */
  toolCallId: string;
  subagentRunId?: string;
  toolName: string;
  input: Record<string, unknown>;
  /** Monotonic start order; the most recent wins a command match. */
  order: number;
}

/**
 * Which tool call a request belongs to (§3.5.4). The gate's own call for a
 * gate request; for sandbox asks, the most recently started running call
 * whose command matches, else the single running bash call.
 */
export function attachToolCall(
  request: PermissionRequest,
  fromGate: boolean,
  running: readonly RunningCall[]
): Pick<PermissionDescriptor, "toolCallId" | "subagentRunId"> & {
  attachedBy: PermissionDescriptor["metadata"]["abacus"]["attachedBy"];
} {
  if (fromGate) {
    // The AG-UI id the tool call was emitted under (the reservation).
    return { toolCallId: nativeId(request.tool.id), attachedBy: "gate" };
  }

  if (request.type === "sandbox_denied") {
    const match = [...running]
      .filter((call) => call.input.command === request.command)
      .sort((a, b) => b.order - a.order)[0];

    if (match != null) {
      return {
        toolCallId: match.toolCallId,
        ...(match.subagentRunId != null
          ? { subagentRunId: match.subagentRunId }
          : {}),
        attachedBy: "command-match",
      };
    }
  }

  if (request.type === "sandbox_denied" || request.type === "network_host") {
    const bash = running.filter((call) => call.toolName === "bash");

    if (bash.length === 1) {
      const sole = bash[0]!;

      return {
        toolCallId: sole.toolCallId,
        ...(sole.subagentRunId != null
          ? { subagentRunId: sole.subagentRunId }
          : {}),
        attachedBy: "sole-running",
      };
    }
  }

  return { attachedBy: "none" };
}

export function toDescriptor(options: {
  permissionId: string;
  request: PermissionRequest;
  lineage: PermissionLineage;
  attach: ReturnType<typeof attachToolCall>;
  expiresAt?: string;
}): PermissionDescriptor {
  const { permissionId, request, lineage, attach, expiresAt } = options;

  return {
    id: permissionId,
    reason:
      request.type === "ask_user_question"
        ? "abacus:question"
        : "abacus:permission",
    message: request.displayName,
    ...(attach.toolCallId != null ? { toolCallId: attach.toolCallId } : {}),
    ...(attach.subagentRunId != null
      ? { subagentRunId: attach.subagentRunId }
      : {}),
    ...(expiresAt != null ? { expiresAt } : {}),
    metadata: {
      abacus: {
        lineage,
        kind: request.type,
        request,
        attachedBy: attach.attachedBy,
        allowed: allowedDecisions(request.type),
      },
    },
  };
}

/**
 * Every check a `permission.respond` must pass before anything is answered
 * (§3.5.3). Returns the failure reason, or null when it may be applied.
 */
export function validateResponse(options: {
  lineage: unknown;
  decision: unknown;
  threadId: string;
  incarnation: string;
  pending: ReadonlyMap<string, PendingPermission>;
}): ResponseRejectedReason | null {
  const { threadId, incarnation, pending } = options;
  const lineage = options.lineage as Partial<PermissionLineage> | null;

  if (lineage == null || typeof lineage !== "object") return "not_pending";
  if (lineage.incarnation !== incarnation) return "incarnation";
  if (lineage.threadId !== threadId) return "thread";

  const entry =
    typeof lineage.permissionId === "string"
      ? pending.get(lineage.permissionId)
      : undefined;

  if (entry == null) return "not_pending";
  if (lineage.turnSeq !== entry.turnSeq) return "turn";
  if (!isPermissionDecision(options.decision)) return "invalid_decision";
  if (
    !entry.descriptor.metadata.abacus.allowed.includes(
      decisionKind(options.decision)
    )
  ) {
    return "decision_not_allowed";
  }

  return null;
}
