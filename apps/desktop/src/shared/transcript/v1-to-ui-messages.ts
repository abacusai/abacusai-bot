/**
 * v1 transcript segments → TanStack AI `UIMessage`s (spec 00 C.3). Pure: no
 * Node or Electron, so migration step 1, the thread store's dual-write and
 * repair, and tests all share it.
 *
 * Every input segment is traced. It is listed, in order, in the
 * `metadata.abacus.segments` of the message it contributed to (or, for a
 * sub-agent's close frame, of its `SubagentPart`), and every part carries its
 * segment id where the part type allows it:
 *
 * | Part | Segment id |
 * |---|---|
 * | text | `metadata.abacus.segmentId` |
 * | tool-call | `metadata.abacus.segmentId` (`id` stays the tool call id) |
 * | tool-result | `id` = segment id + `"#result"` |
 * | image, video | `metadata.abacus.segmentId` |
 * | thinking | `stepId` |
 * | subagent | `subagent.id` = the bracket's `created` id |
 *
 * What is kept, and where:
 * - Legacy segment kinds with no part of their own become text parts tagged
 *   `metadata.abacus.kind` (the chat kit dispatches on it, spec 02 §5.3).
 * - Anything unrecognised, and a known type whose required fields are missing
 *   or mistyped, becomes `kind: "unknown"` with the raw segment.
 * - Keys of a known type the mapper does not read are kept in the provenance
 *   entry's `extra`. `isSpinny` is the one field read and dropped: history is
 *   never live, and the old UI forces it to false.
 * - A tool call the old UI hides because a newer segment carries the same
 *   call id (`derivations.ts` `omitSupersededToolLifecycleSegments`) keeps
 *   its raw segment in its provenance entry, with `supersededBy`.
 *
 * Ids made unique by the mapper use `#` (`id#2`, `id#0`, `id#result`), which
 * the agent's AG-UI ids never contain (they use `:`), so a deduplicated or
 * derived id cannot collide with one an AG-UI writer appends later.
 */
import type {
  ImagePart,
  MessagePart,
  SubagentPart,
  TextPart,
  ThinkingPart,
  ToolCallPart,
  ToolCallState,
  ToolResultPart,
  UIMessage,
  VideoPart,
} from "@tanstack/ai";

import {
  attachmentRefs,
  hasSystemReminder,
  isRoutineFire,
  type AttachmentRef,
} from "./user-text";

/** One v1 segment's trace in a v2 message (`metadata.abacus.segments[]`). */
export interface SegmentProvenance {
  id: string;
  /** The v1 segment type (`"unknown"` when it had none). */
  type: string;
  /** Epoch ms, when the segment was stamped. */
  at?: number;
  /** Index of the part it produced in the message, or null (none). */
  partIndex: number | null;
  /** The `tool_group` segment it was a member of. */
  groupId?: string;
  /** Display-only fields kept here rather than dropped. */
  title?: string;
  category?: string;
  summary?: string;
  /** `subtask` frames: `created` or `completed`, and the close's outcome. */
  status?: string;
  outcome?: string;
  /** Turn fields the segment carried (the message keeps the first). */
  messageIndex?: number;
  regenerateAttempt?: number;
  /** Only when it differs from the message's `versions`. */
  versions?: unknown;
  /** A tool call hidden because a newer segment has the same call id. */
  supersededBy?: string;
  /** The superseded segment, verbatim. */
  raw?: unknown;
  /** Keys of a known segment type that the mapper does not read. */
  extra?: Record<string, unknown>;
}

/** Tags on a migrated user message (spec 02 §5, `user-text.ts`). */
export interface UserTextTags {
  /** A routine firing: the old UI hides the whole message. */
  routineFire?: true;
  /** Holds `<system_reminder>` blocks, which the old UI strips. */
  systemReminder?: true;
  /** The `@/abs/path` mentions the old UI shows as pills and thumbnails. */
  attachments?: AttachmentRef[];
}

export interface AbacusMessageMetadata {
  segments: SegmentProvenance[];
  messageIndex?: number;
  regenerateAttempt?: number;
  versions?: unknown;
  /** Per credits segment, not summed. */
  credits?: Array<{ segmentId: string; creditsUsed: number }>;
  /** User messages. */
  userText?: UserTextTags;
  /**
   * The old UI's feedback row: under the turn's last top-level bot text
   * (`segmentId`), rated as backend message `index` (`2 × users − 1`,
   * counted positionally, `feedback-row.tsx`).
   */
  feedback?: { segmentId: string; index: number };
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** Absent, or of the expected kind. */
const optional = (value: unknown, check: (value: unknown) => boolean) =>
  value === undefined || check(value);

const isString = (value: unknown): boolean => typeof value === "string";

/** `Date` accepts ±8.64e15 ms; a stamp beyond it is kept but dates nothing. */
const MAX_DATE_MS = 8.64e15;

/** Copies only the keys whose value is not `undefined`. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;

/** The keys of `value` outside `known`, or undefined when there are none. */
const extraKeys = (value: Rec, known: ReadonlySet<string>): Rec | undefined => {
  let extra: Rec | undefined;
  for (const [key, entry] of Object.entries(value))
    if (!known.has(key)) (extra ??= {})[key] = entry;
  return extra;
};

/**
 * Unique ids within one namespace. A taken id gets `#2`, `#3`, … The next
 * suffix is remembered per base, so repeated ids stay linear.
 */
const claimer = () => {
  const used = new Set<string>();
  const next = new Map<string, number>();
  return (id: string): string => {
    if (!used.has(id)) {
      used.add(id);
      return id;
    }
    let n = next.get(id) ?? 2;
    let unique = `${id}#${n}`;
    while (used.has(unique)) unique = `${id}#${++n}`;
    next.set(id, n + 1);
    used.add(unique);
    return unique;
  };
};

interface Target {
  message: UIMessage;
  abacus: AbacusMessageMetadata;
}

const newTarget = (id: string, role: "user" | "assistant"): Target => {
  const abacus: AbacusMessageMetadata = { segments: [] };
  return {
    message: { id, role, parts: [], metadata: { abacus } },
    abacus,
  };
};

const record = (target: Target, entry: SegmentProvenance): void => {
  target.abacus.segments.push(defined(entry));
  if (entry.at === undefined || Math.abs(entry.at) > MAX_DATE_MS) return;
  const metadata = target.message.metadata as Rec;
  if (metadata.tanstack === undefined)
    metadata.tanstack = { createdAt: new Date(entry.at).toISOString() };
};

const pushPart = (target: Target, part: MessagePart): number => {
  target.message.parts.push(part);
  return target.message.parts.length - 1;
};

/** A text part tagged with the legacy segment kind (spec 02 §5.3). */
const kindText = (
  content: string,
  segmentId: string,
  kind: string,
  extra: Rec = {}
): TextPart => ({
  type: "text",
  content,
  metadata: { abacus: defined({ segmentId, kind, ...extra }) },
});

// ─── Known keys (anything else goes to `extra`) ─────────────────────────────

const TURN_KEYS = [
  "type",
  "id",
  "at",
  "messageIndex",
  "regenerateAttempt",
  "versions",
];

const KNOWN_KEYS: Record<string, ReadonlySet<string>> = Object.fromEntries(
  Object.entries({
    text: ["source", "content"],
    thinking: ["content", "title", "isSpinny"],
    collapsible: ["content", "title", "isSpinny"],
    tool_call: [
      "toolCall",
      "toolResult",
      "toolUseRequest",
      "toolUseResult",
      "toolPhase",
      "parsedResult",
      "toolDisplayData",
    ],
    notification: ["message", "severity", "actions", "notificationKey"],
    credits: ["creditsUsed"],
    web_search_results: ["query", "resultType", "results"],
    media: ["media"],
    feature_limit: ["featureName", "limitType"],
    compaction: ["summary"],
    subtask: [
      "status",
      "description",
      "kind",
      "startTime",
      "endTime",
      "outcome",
    ],
    tool_group: ["tools", "category", "summary"],
  }).map(([type, keys]) => [type, new Set([...TURN_KEYS, ...keys])])
);

const CALL_KEYS = new Set(["id", "name", "args", "status", "endpoint"]);
const RESULT_KEYS = new Set(["output", "error", "rejection", "data"]);
const REQUEST_KEYS = new Set(["id", "name", "input", "args", "type"]);

// ─── Tool calls ──────────────────────────────────────────────────────────────

interface CanonicalTool {
  call: {
    /** The stored call id (null: none stored; the segment id stands in). */
    storedId: string | null;
    name: string;
    args: Rec;
    status: string | undefined;
    endpoint: string | undefined;
  };
  result: Rec | undefined;
  /** Fields of the agent protocol's older shape, kept verbatim. */
  legacy?: Rec;
  /** Nested keys the mapper does not read. */
  extra?: Rec;
}

const FILE_MUTATION_TOOLS = new Set([
  "write",
  "edit",
  "ast_edit",
  "batch_edit",
]);
const READ_TOOLS = new Set(["read", "batch_file_read"]);

const lineCount = (text: string): number =>
  text === "" ? 0 : text.split("\n").length;

/**
 * The legacy `ToolResultData` (`agent-types.ts`) for the agent protocol's
 * older shape, from its display fields (`toolDisplayData`, `displayContent`,
 * `old_content`), so spec 02 §5.4a's migrated normalisation, which reads
 * `result.metadata.abacus.data`, finds reads, diffs and terminal output.
 */
const protocolResultData = (
  name: string,
  args: Rec,
  result: Rec,
  display: Rec | undefined
): Rec | undefined => {
  const content = str(result.content) ?? "";
  const shown = str(result.displayContent) ?? content;
  if (READ_TOOLS.has(name))
    return defined({
      type: "read",
      content: shown,
      lineCount: num(display?.lineCount) ?? lineCount(shown),
      filePath: str(args.file_path) ?? str(args.path),
    });
  if (FILE_MUTATION_TOOLS.has(name))
    return defined({
      type: "file_mutation",
      originalContent: str(display?.originalContent) ?? str(result.old_content),
      finalContent: str(display?.finalContent) ?? str(display?.newContent),
      isNewFile:
        typeof display?.isNewFile === "boolean" ? display.isNewFile : undefined,
      additions: num(display?.additions),
      deletions: num(display?.deletions),
    });
  if (name === "bash")
    return { type: "bash", command: str(args.command) ?? "", output: shown };
  return result.displayContent === undefined
    ? undefined
    : { type: "generic", output: shown };
};

/**
 * The renderer's `{ toolCall, toolResult? }`, or the agent protocol's older
 * `{ toolUseRequest, toolUseResult?, toolPhase }` (`protocol.ts`), which has
 * no status: a stored result is a success unless `rejected`, and no result
 * means the call never finished. Null when the shape is invalid (no
 * non-empty string name, mistyped args, id, status or result): such a
 * segment is kept verbatim as `unknown`, as the old UI drops a nameless call
 * (`hydration.ts`).
 */
const canonicalTool = (segment: Rec): CanonicalTool | null => {
  const call = segment.toolCall;
  if (isRecord(call)) {
    const result = segment.toolResult;
    if (
      typeof call.name !== "string" ||
      call.name === "" ||
      !optional(call.args, isRecord) ||
      !optional(call.id, isString) ||
      !optional(call.status, isString) ||
      !optional(call.endpoint, isString) ||
      !optional(result, isRecord)
    )
      return null;
    const stored = result as Rec | undefined;
    if (
      stored !== undefined &&
      (!optional(stored.output, isString) ||
        !optional(stored.error, isString) ||
        !optional(stored.rejection, isRecord) ||
        !optional(stored.data, isRecord))
    )
      return null;
    const storedId = str(call.id) ?? null;
    const callExtra = extraKeys(call, CALL_KEYS);
    const resultKnown =
      stored?.toolCallId === (storedId ?? undefined)
        ? new Set([...RESULT_KEYS, "toolCallId"])
        : RESULT_KEYS;
    const resultExtra =
      stored === undefined ? undefined : extraKeys(stored, resultKnown);
    return {
      call: {
        storedId,
        name: call.name,
        args: (call.args as Rec | undefined) ?? {},
        status: str(call.status),
        endpoint: str(call.endpoint),
      },
      result: stored,
      extra:
        callExtra === undefined && resultExtra === undefined
          ? undefined
          : defined({ toolCall: callExtra, toolResult: resultExtra }),
    };
  }
  const request = segment.toolUseRequest;
  if (!isRecord(request)) return null;
  const legacyResult = segment.toolUseResult;
  if (
    typeof request.name !== "string" ||
    request.name === "" ||
    !optional(request.id, isString) ||
    !optional(request.input, isRecord) ||
    !optional(request.args, isRecord) ||
    !optional(legacyResult, isRecord) ||
    (isRecord(legacyResult) && !optional(legacyResult.content, isString))
  )
    return null;
  const storedId = str(request.id) ?? null;
  const args = (request.input ?? request.args ?? {}) as Rec;
  const rejected = isRecord(legacyResult) && legacyResult.rejected === true;
  const display = isRecord(segment.toolDisplayData)
    ? segment.toolDisplayData
    : undefined;
  const data = isRecord(legacyResult)
    ? protocolResultData(request.name, args, legacyResult, display)
    : undefined;
  return {
    call: {
      storedId,
      name: request.name,
      args,
      status:
        legacyResult === undefined
          ? "interrupted"
          : rejected
            ? "rejected"
            : "success",
      endpoint: undefined,
    },
    result: isRecord(legacyResult)
      ? defined({
          output: str(legacyResult.content) ?? "",
          data,
          ...(rejected ? { rejection: { reason: "rejected" } } : {}),
        })
      : undefined,
    legacy: defined({
      toolPhase: segment.toolPhase,
      toolUseResult: legacyResult,
      parsedResult: segment.parsedResult,
      toolDisplayData: segment.toolDisplayData,
      // `args` is the same object as `input` by protocol; kept if not.
      toolUseRequest: extraKeys(
        request,
        request.input !== undefined &&
          request.args !== undefined &&
          JSON.stringify(request.args) !== JSON.stringify(request.input)
          ? new Set(["id", "name", "input", "type"])
          : REQUEST_KEYS
      ),
      requestType: request.type === "tool_use" ? undefined : request.type,
    }),
  };
};

interface ToolStates {
  call: ToolCallState;
  result: "complete" | "error";
  outcome?: "denied" | "cancelled";
  approval?: boolean;
  /** `error` on a synthesised result. */
  syntheticError?: string;
}

const CANCELLED_STATUSES = new Set(["interrupted", "skipped", "abandoned"]);
const MID_FLIGHT_STATUSES = new Set([
  "pending",
  "executing",
  "awaiting_permission",
]);

/** The C.3 state table: first matching row wins, top to bottom. */
const toolStates = (
  status: string | undefined,
  result: Rec | undefined
): ToolStates => {
  const rejection = isRecord(result?.rejection)
    ? str(result.rejection.reason)
    : undefined;
  const error = str(result?.error);
  if (
    (status === "success" || status === undefined) &&
    rejection === undefined &&
    error === undefined
  )
    return { call: "complete", result: "complete" };
  if (status === "error" || error !== undefined)
    return { call: "error", result: "error", syntheticError: "failed" };
  if (status === "rejected" || rejection === "rejected")
    return {
      call: "approval-responded",
      result: "error",
      outcome: "denied",
      approval: true,
    };
  if (
    rejection === "interrupted" ||
    rejection === "sibling_failed" ||
    (status !== undefined && CANCELLED_STATUSES.has(status)) ||
    (status !== undefined && MID_FLIGHT_STATUSES.has(status))
  )
    return { call: "error", result: "error", outcome: "cancelled" };
  // An unknown status with no error or rejection: hydration reads a missing
  // status as a success, so an unrecognised one is treated the same way.
  return rejection === undefined
    ? { call: "complete", result: "complete" }
    : { call: "error", result: "error", outcome: "cancelled" };
};

/** Keys of `ToolResultData` that can repeat the result's text. */
const DATA_TEXT_KEYS = ["output", "content"] as const;

/**
 * The legacy `ToolResultData` with any text field equal to the result's
 * `content` left out and named in `fromContent`, so a tool's output is stored
 * once. `expandToolResultData` restores it.
 */
const compactData = (data: unknown, content: string): unknown => {
  if (!isRecord(data) || content === "") return data;
  const fromContent = DATA_TEXT_KEYS.filter((key) => data[key] === content);
  if (fromContent.length === 0) return data;
  const compact: Rec = { ...data, fromContent };
  for (const key of fromContent) delete compact[key];
  return compact;
};

/**
 * A migrated tool result's legacy `ToolResultData` as it was stored: the
 * fields the mapper left out because they equalled `content` are put back.
 * The chat kit's migrated normalisation (spec 02 §5.4a) reads data through
 * this.
 */
export const expandToolResultData = (
  result: Pick<ToolResultPart, "content" | "metadata">
): Rec | undefined => {
  const data = (result.metadata as { abacus?: { data?: unknown } } | undefined)
    ?.abacus?.data;
  if (!isRecord(data)) return undefined;
  const fromContent = data.fromContent;
  if (!Array.isArray(fromContent)) return data;
  const full: Rec = { ...data };
  delete full.fromContent;
  const content = typeof result.content === "string" ? result.content : "";
  for (const key of fromContent)
    if (typeof key === "string") full[key] = content;
  return full;
};

// ─── The mapper ──────────────────────────────────────────────────────────────

interface OpenBracket {
  part: SubagentPart;
  /** The child message segments are mapped into (the last of `messages`). */
  child: Target;
}

/** The trace id of each value, as the mapper walks it. */
const traceOrder = (
  segments: readonly unknown[],
  visit: (value: unknown, id: string) => void
): void => {
  const walk = (value: unknown, fallback: string) => {
    const id = isRecord(value) ? (str(value.id) ?? fallback) : fallback;
    visit(value, id);
    if (
      isRecord(value) &&
      value.type === "tool_group" &&
      Array.isArray(value.tools)
    )
      value.tools.forEach((member, index) => walk(member, `${id}:${index}`));
  };
  segments.forEach((segment, index) => walk(segment, `segment-${index}`));
};

/**
 * Maps a v1 file's `segments` to UI messages. Total: any value in the array
 * maps to something, and the result depends only on the input.
 */
export function v1ToUiMessages(segments: readonly unknown[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let assistant: Target | null = null;
  let open: OpenBracket | null = null;
  // Closed by a user text: the old UI keeps such a bracket open, so the next
  // `created` settles it as a hand-back and the next close frame as its own.
  let provisional: OpenBracket | null = null;
  // Unique per namespace: message ids (keys, `before` cursors), tool call ids
  // (TanStack pairs results by them), result part ids, and sub-agent ids.
  const claimMessage = claimer();
  const claimCall = claimer();
  const claimResult = claimer();
  const claimSubagent = claimer();

  // The old UI shows only the newest segment per tool call id.
  const tools = new WeakMap<object, CanonicalTool | null>();
  const toolOf = (value: Rec): CanonicalTool | null => {
    if (!tools.has(value)) tools.set(value, canonicalTool(value));
    return tools.get(value) ?? null;
  };
  const newestByCall = new Map<string, { value: object; id: string }>();
  traceOrder(segments, (value, id) => {
    if (!isRecord(value) || value.type !== "tool_call") return;
    const callId = toolOf(value)?.call.storedId;
    if (callId != null) newestByCall.set(callId, { value, id });
  });

  /** Turn fields for a provenance entry. */
  const turnTrace = (
    target: Target,
    segment: Rec
  ): Partial<SegmentProvenance> => ({
    messageIndex: num(segment.messageIndex),
    regenerateAttempt: num(segment.regenerateAttempt),
    versions:
      isRecord(segment.versions) && target.abacus.versions !== segment.versions
        ? segment.versions
        : undefined,
  });

  const takeTurnFields = (target: Target, segment: Rec): void => {
    const messageIndex = num(segment.messageIndex);
    if (messageIndex !== undefined && target.abacus.messageIndex === undefined)
      target.abacus.messageIndex = messageIndex;
    const attempt = num(segment.regenerateAttempt);
    if (attempt !== undefined && target.abacus.regenerateAttempt === undefined)
      target.abacus.regenerateAttempt = attempt;
    if (isRecord(segment.versions) && target.abacus.versions === undefined)
      target.abacus.versions = segment.versions;
  };

  /** Whether `segment` starts a new message after `target` (C.3). */
  const splits = (target: Target, segment: Rec): boolean => {
    const messageIndex = num(segment.messageIndex);
    return (
      messageIndex !== undefined &&
      target.abacus.messageIndex !== undefined &&
      target.abacus.messageIndex !== messageIndex
    );
  };

  /**
   * The message a non-user segment goes to: the open bracket's child (a new
   * child when the ordinal changes), else the current assistant message, or
   * a new one after a user message or on an ordinal change.
   */
  const targetFor = (segment: Rec, id: string): Target => {
    if (open !== null) {
      if (splits(open.child, segment)) {
        const { subagent } = open.part;
        const child = newTarget(
          claimMessage(`${subagent.id}#${subagent.messages.length}`),
          "assistant"
        );
        subagent.messages.push(child.message);
        open.child = child;
      }
      takeTurnFields(open.child, segment);
      return open.child;
    }
    if (assistant !== null && splits(assistant, segment)) assistant = null;
    if (assistant === null) {
      assistant = newTarget(claimMessage(id), "assistant");
      messages.push(assistant.message);
    }
    takeTurnFields(assistant, segment);
    return assistant;
  };

  const settle = (
    bracket: OpenBracket,
    outcome: "completed" | "interrupted",
    close?: { entry: SegmentProvenance; endTime: number | undefined }
  ): void => {
    const subagent = bracket.part.subagent;
    if (outcome === "interrupted") {
      subagent.status = "error";
      subagent.error = { message: "interrupted" };
    } else {
      subagent.status = "finished";
      delete subagent.error;
    }
    if (close !== undefined) {
      const abacus = (subagent.metadata as { abacus: Rec }).abacus;
      if (close.endTime !== undefined) abacus.endTime = close.endTime;
      abacus.segments = [defined(close.entry)];
    }
  };

  const closeOpen = (outcome: "completed" | "interrupted"): void => {
    if (open === null) return;
    settle(open, outcome);
    open = null;
  };

  const handleSubtask = (
    segment: Rec,
    id: string,
    groupId?: string
  ): boolean => {
    const status = str(segment.status);
    const at = num(segment.at);
    if (
      !optional(segment.description, isString) ||
      !optional(segment.kind, isString) ||
      !optional(segment.outcome, isString)
    )
      return false;
    const extra = extraKeys(segment, KNOWN_KEYS.subtask!);
    if (status === "created") {
      // A new bracket while one is open (or held open by the old UI across
      // a user text) is a hand-back.
      closeOpen("completed");
      if (provisional !== null) settle(provisional, "completed");
      provisional = null;
      const target = targetFor(segment, id);
      const subagentId = claimSubagent(id);
      const child = newTarget(claimMessage(`${subagentId}#0`), "assistant");
      const part: SubagentPart = {
        type: "subagent",
        subagent: defined({
          id: subagentId,
          name: str(segment.kind) ?? "delegate",
          description: str(segment.description),
          status: "running" as const,
          messages: [child.message],
          metadata: {
            abacus: defined({
              startTime: num(segment.startTime),
              segmentId: subagentId === id ? undefined : id,
            }),
          },
        }),
      };
      const partIndex = pushPart(target, part);
      record(target, {
        id,
        type: "subtask",
        status,
        at,
        partIndex,
        groupId,
        extra,
        ...turnTrace(target, segment),
      });
      open = { part, child };
      return true;
    }
    if (status === "completed") {
      const outcome = str(segment.outcome);
      const entry: SegmentProvenance = {
        id,
        type: "subtask",
        status,
        outcome,
        at,
        partIndex: null,
        groupId,
        extra,
        messageIndex: num(segment.messageIndex),
        regenerateAttempt: num(segment.regenerateAttempt),
      };
      // Frames written before `outcome` existed only ever meant finished.
      const settled = outcome === "interrupted" ? "interrupted" : "completed";
      const close = { entry, endTime: num(segment.endTime) };
      if (open !== null) {
        settle(open, settled, close);
        open = null;
      } else if (provisional !== null) {
        // The old UI's bracket was still open: its close frame settles it.
        settle(provisional, settled, close);
        provisional = null;
      } else {
        // Unmatched close: ignored, but still traceable.
        const target = targetFor(segment, id);
        record(target, { ...entry, ...turnTrace(target, segment) });
      }
      return true;
    }
    return false;
  };

  const mapTool = (
    target: Target,
    tool: CanonicalTool,
    trace: Omit<SegmentProvenance, "partIndex">
  ): void => {
    const { call, result } = tool;
    const segmentId = trace.id;
    const states = toolStates(call.status, result);
    const originalId = call.storedId ?? segmentId;
    const callId = claimCall(originalId);
    const callPart: ToolCallPart = defined({
      type: "tool-call" as const,
      id: callId,
      name: call.name,
      // `input` is not stored: it is `JSON.parse(arguments)`.
      arguments: JSON.stringify(call.args),
      state: states.call,
      approval: states.approval
        ? { id: `${callId}#approval`, needsApproval: true, approved: false }
        : undefined,
      metadata: {
        abacus: defined({
          segmentId,
          callId: callId === originalId ? undefined : originalId,
          endpoint: call.endpoint,
          status: call.status,
          legacy: tool.legacy,
        }),
      },
    });
    record(target, {
      ...trace,
      extra:
        tool.extra === undefined
          ? trace.extra
          : { ...trace.extra, ...tool.extra },
      partIndex: pushPart(target, callPart),
    });

    // A result part always follows (C.3; for a success with none stored,
    // as hydration's `completedHistoricalResult` does), and holds the output
    // once: the call part has no `output`.
    const content = result === undefined ? "" : (str(result.output) ?? "");
    const error =
      result === undefined ? states.syntheticError : str(result.error);
    const resultPart: ToolResultPart = defined({
      type: "tool-result" as const,
      id: claimResult(`${segmentId}#result`),
      toolCallId: callId,
      content,
      state: states.result,
      outcome: states.outcome,
      error: states.result === "error" ? error : undefined,
      metadata: {
        abacus: defined({
          data: compactData(result?.data, content),
          rejection: result?.rejection,
          synthesised: result === undefined ? true : undefined,
        }),
      },
    });
    pushPart(target, resultPart);
  };

  const mapInto = (
    target: Target,
    segment: Rec,
    id: string,
    type: string | undefined,
    groupId: string | undefined
  ): void => {
    const known = type === undefined ? undefined : KNOWN_KEYS[type];
    const trace: Omit<SegmentProvenance, "partIndex"> = {
      id,
      type: type ?? "unknown",
      at: num(segment.at),
      groupId,
      extra: known === undefined ? undefined : extraKeys(segment, known),
      ...turnTrace(target, segment),
    };
    const add = (part: MessagePart, extra: Partial<SegmentProvenance> = {}) =>
      record(target, { ...trace, ...extra, partIndex: pushPart(target, part) });

    switch (type) {
      case "text": {
        const content = str(segment.content);
        if (content === undefined) break;
        add({ type: "text", content, metadata: { abacus: { segmentId: id } } });
        return;
      }
      case "thinking": {
        const content = str(segment.content);
        if (content === undefined || !optional(segment.title, isString)) break;
        const part: ThinkingPart = { type: "thinking", content, stepId: id };
        add(part, { title: str(segment.title) });
        return;
      }
      case "collapsible": {
        const content = str(segment.content);
        if (content === undefined || !optional(segment.title, isString)) break;
        add(
          kindText(content, id, "collapsible", { title: str(segment.title) })
        );
        return;
      }
      case "tool_call": {
        const tool = toolOf(segment);
        if (tool === null) break;
        const newest =
          tool.call.storedId === null
            ? undefined
            : newestByCall.get(tool.call.storedId);
        if (newest !== undefined && newest.value !== segment) {
          record(target, {
            ...trace,
            extra: undefined,
            partIndex: null,
            supersededBy: newest.id,
            raw: segment,
          });
          return;
        }
        mapTool(target, tool, trace);
        return;
      }
      case "notification": {
        const message = str(segment.message);
        if (
          message === undefined ||
          !optional(segment.severity, isString) ||
          !optional(segment.actions, Array.isArray) ||
          !optional(segment.notificationKey, isString)
        )
          break;
        add(
          kindText(message, id, "notification", {
            severity: str(segment.severity) ?? "info",
            actions: segment.actions,
            notificationKey: str(segment.notificationKey),
          })
        );
        return;
      }
      case "credits": {
        const creditsUsed = num(segment.creditsUsed);
        if (creditsUsed === undefined) break;
        (target.abacus.credits ??= []).push({ segmentId: id, creditsUsed });
        record(target, { ...trace, partIndex: null });
        return;
      }
      case "web_search_results": {
        const query = str(segment.query);
        if (
          query === undefined ||
          !Array.isArray(segment.results) ||
          !optional(segment.resultType, isString)
        )
          break;
        add(
          kindText(query, id, "web_search_results", {
            resultType: str(segment.resultType) ?? "web",
            results: segment.results,
          })
        );
        return;
      }
      case "media": {
        const media = isRecord(segment.media) ? segment.media : undefined;
        const url = str(media?.url);
        const kind = str(media?.kind);
        if (media === undefined || url === undefined) break;
        const known = new Set([
          "kind",
          "url",
          "width",
          "height",
          "prompt",
          "model",
          ...(kind === "video" ? ["aspectRatio", "duration", "loop"] : []),
        ]);
        const mediaExtra = extraKeys(media, known);
        const extra =
          mediaExtra === undefined
            ? {}
            : { extra: { ...trace.extra, media: mediaExtra } };
        const common = {
          segmentId: id,
          width: num(media.width),
          height: num(media.height),
          prompt: str(media.prompt),
          model: str(media.model),
        };
        if (kind === "image") {
          const part: ImagePart = {
            type: "image",
            source: { type: "url", value: url },
            metadata: { abacus: defined(common) },
          };
          add(part, extra);
          return;
        }
        if (kind === "video") {
          const part: VideoPart = {
            type: "video",
            source: { type: "url", value: url },
            metadata: {
              abacus: defined({
                ...common,
                aspectRatio: str(media.aspectRatio),
                duration: num(media.duration),
                loop: media.loop === true,
              }),
            },
          };
          add(part, extra);
          return;
        }
        break;
      }
      case "feature_limit": {
        const featureName = str(segment.featureName);
        if (featureName === undefined || !optional(segment.limitType, isString))
          break;
        add(
          kindText(featureName, id, "feature_limit", {
            featureName,
            limitType: str(segment.limitType) ?? "",
          })
        );
        return;
      }
      case "compaction": {
        const summary = str(segment.summary);
        if (summary === undefined) break;
        add(kindText(summary, id, "compaction"));
        return;
      }
      default:
        break;
    }
    // Unknown, or a known type whose required fields are missing: lossless.
    add(kindText("", id, "unknown", { raw: segment }), { extra: undefined });
  };

  const userTags = (content: string): UserTextTags | undefined => {
    const attachments = attachmentRefs(content);
    const tags = defined<UserTextTags>({
      routineFire: isRoutineFire(content) ? true : undefined,
      systemReminder: hasSystemReminder(content) ? true : undefined,
      attachments: attachments.length === 0 ? undefined : attachments,
    });
    return Object.keys(tags).length === 0 ? undefined : tags;
  };

  const handle = (
    value: unknown,
    fallbackId: string,
    groupId?: string
  ): void => {
    const segment: Rec = isRecord(value) ? value : {};
    const id = str(segment.id) ?? fallbackId;
    const type = isRecord(value) ? str(segment.type) : undefined;

    if (!isRecord(value)) {
      // Not even an object: kept as raw, in whatever message is current.
      const target = targetFor(segment, id);
      record(target, {
        id,
        type: "unknown",
        partIndex: pushPart(
          target,
          kindText("", id, "unknown", { raw: value })
        ),
        groupId,
      });
      return;
    }

    if (type === "text" && segment.source === "user") {
      // Cannot occur inside a bracket in v1 output. If it does, the bracket
      // closes here as interrupted until its own close frame, or a hand-back,
      // settles it (the old UI keeps it open).
      if (open !== null) {
        settle(open, "interrupted");
        provisional = open;
        open = null;
      }
      const user = newTarget(claimMessage(id), "user");
      takeTurnFields(user, segment);
      const tags =
        typeof segment.content === "string"
          ? userTags(segment.content)
          : undefined;
      if (tags !== undefined) user.abacus.userText = tags;
      messages.push(user.message);
      mapInto(user, segment, id, type, groupId);
      assistant = null;
      return;
    }

    if (type === "subtask" && handleSubtask(segment, id, groupId)) return;

    if (type === "tool_group" && Array.isArray(segment.tools)) {
      const target = targetFor(segment, id);
      record(target, {
        id,
        type,
        at: num(segment.at),
        partIndex: null,
        groupId,
        category: str(segment.category),
        summary: str(segment.summary),
        extra: extraKeys(segment, KNOWN_KEYS.tool_group!),
        ...turnTrace(target, segment),
      });
      segment.tools.forEach((member, index) =>
        handle(member, `${id}:${index}`, id)
      );
      return;
    }

    mapInto(targetFor(segment, id), segment, id, type, groupId);
  };

  segments.forEach((segment, index) => handle(segment, `segment-${index}`));
  // History is never live: an unclosed bracket was interrupted.
  closeOpen("interrupted");
  markFeedback(messages);
  return messages;
}

/**
 * `computeFeedbackMessageIndices` over the top-level messages: each turn's
 * last bot text gets `2 × users − 1`, users counted positionally. A turn
 * before the first user message has no row.
 */
const markFeedback = (messages: readonly UIMessage[]): void => {
  let users = 0;
  let last: { message: UIMessage; segmentId: string } | null = null;
  const flush = () => {
    if (last !== null && users > 0)
      (
        last.message.metadata as { abacus: AbacusMessageMetadata }
      ).abacus.feedback = { segmentId: last.segmentId, index: 2 * users - 1 };
    last = null;
  };
  for (const message of messages) {
    if (message.role === "user") {
      flush();
      users += 1;
      continue;
    }
    for (const part of message.parts) {
      if (part.type !== "text") continue;
      const abacus = (
        part.metadata as { abacus?: { segmentId?: string; kind?: string } }
      )?.abacus;
      if (abacus?.kind === undefined && abacus?.segmentId !== undefined)
        last = { message, segmentId: abacus.segmentId };
    }
  }
  flush();
};
