/**
 * v1 transcript segments → TanStack AI `UIMessage`s (spec 00 C.3). Pure: no
 * Node or Electron, so migration step 1, the thread store's dual-write and
 * repair, and tests all share it.
 *
 * Nothing is dropped. Every input segment is listed, in order, in the
 * `metadata.abacus.segments` of the message it contributed to (or, for a
 * sub-agent's close frame, of its `SubagentPart`), and every part carries its
 * segment id where the part type allows it:
 *
 * | Part | Segment id |
 * |---|---|
 * | text | `metadata.abacus.segmentId` |
 * | tool-call | `metadata.abacus.segmentId` (`id` stays the tool call id) |
 * | tool-result | `id` = segment id + `":result"` |
 * | image, video | `metadata.abacus.segmentId` |
 * | thinking | `stepId` |
 * | subagent | `subagent.id` = the bracket's `created` id |
 *
 * Legacy segment kinds with no part of their own become text parts tagged
 * `metadata.abacus.kind` (the chat kit dispatches on it, spec 02 §5.3);
 * anything unrecognised becomes `kind: "unknown"` with the raw segment.
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
}

export interface AbacusMessageMetadata {
  segments: SegmentProvenance[];
  messageIndex?: number;
  regenerateAttempt?: number;
  versions?: unknown;
  /** Per credits segment, not summed. */
  credits?: Array<{ segmentId: string; creditsUsed: number }>;
}

type Rec = Record<string, unknown>;

const isRecord = (value: unknown): value is Rec =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const str = (value: unknown): string | undefined =>
  typeof value === "string" ? value : undefined;

const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

/** `Date` accepts ±8.64e15 ms; a stamp beyond it is kept but dates nothing. */
const MAX_DATE_MS = 8.64e15;

/** Copies only the keys whose value is not `undefined`. */
const defined = <T extends object>(value: T): T =>
  Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined)
  ) as T;

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

// ─── Tool calls ──────────────────────────────────────────────────────────────

interface CanonicalTool {
  call: {
    id: string;
    name: string;
    args: Rec;
    status: string | undefined;
    endpoint: string | undefined;
  };
  result: Rec | undefined;
  /** Fields of the agent protocol's older shape, kept verbatim. */
  legacy?: Rec;
}

/**
 * The renderer's `{ toolCall, toolResult? }`, or the agent protocol's older
 * `{ toolUseRequest, toolUseResult?, toolPhase }` (`protocol.ts`), which has
 * no status: a stored result is a success unless `rejected`, and no result
 * means the call never finished.
 */
const canonicalTool = (
  segment: Rec,
  segmentId: string
): CanonicalTool | null => {
  const call = segment.toolCall;
  if (isRecord(call)) {
    return {
      call: {
        id: str(call.id) ?? segmentId,
        name: str(call.name) ?? "",
        args: isRecord(call.args) ? call.args : {},
        status: str(call.status),
        endpoint: str(call.endpoint),
      },
      result: isRecord(segment.toolResult) ? segment.toolResult : undefined,
    };
  }
  const request = segment.toolUseRequest;
  if (!isRecord(request)) return null;
  const legacyResult = isRecord(segment.toolUseResult)
    ? segment.toolUseResult
    : undefined;
  const id = str(request.id) ?? segmentId;
  const args = isRecord(request.input)
    ? request.input
    : isRecord(request.args)
      ? request.args
      : {};
  const rejected = legacyResult?.rejected === true;
  return {
    call: {
      id,
      name: str(request.name) ?? "",
      args,
      status:
        legacyResult === undefined
          ? "interrupted"
          : rejected
            ? "rejected"
            : "success",
      endpoint: undefined,
    },
    result:
      legacyResult === undefined
        ? undefined
        : defined({
            toolCallId: id,
            output: str(legacyResult.content) ?? "",
            ...(rejected ? { rejection: { reason: "rejected" } } : {}),
          }),
    legacy: defined({
      toolPhase: segment.toolPhase,
      toolUseResult: legacyResult,
      parsedResult: segment.parsedResult,
      toolDisplayData: segment.toolDisplayData,
    }),
  };
};

interface ToolStates {
  call: ToolCallState;
  result: "complete" | "error";
  outcome?: "denied" | "cancelled";
  approval?: boolean;
  /** A result part is synthesised when none was stored. */
  synthesise: boolean;
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
    return { call: "complete", result: "complete", synthesise: false };
  if (status === "error" || error !== undefined)
    return {
      call: "error",
      result: "error",
      synthesise: true,
      syntheticError: "failed",
    };
  if (status === "rejected" || rejection === "rejected")
    return {
      call: "approval-responded",
      result: "error",
      outcome: "denied",
      approval: true,
      synthesise: true,
    };
  if (
    rejection === "interrupted" ||
    rejection === "sibling_failed" ||
    (status !== undefined && CANCELLED_STATUSES.has(status)) ||
    (status !== undefined && MID_FLIGHT_STATUSES.has(status))
  )
    return {
      call: "error",
      result: "error",
      outcome: "cancelled",
      synthesise: true,
    };
  // An unknown status with no error or rejection: hydration reads a missing
  // status as a success, so an unrecognised one is treated the same way.
  return rejection === undefined
    ? { call: "complete", result: "complete", synthesise: false }
    : {
        call: "error",
        result: "error",
        outcome: "cancelled",
        synthesise: true,
      };
};

const toolParts = (
  segmentId: string,
  tool: CanonicalTool
): [ToolCallPart, ToolResultPart | undefined] => {
  const { call, result } = tool;
  const states = toolStates(call.status, result);
  const output = result === undefined ? undefined : result.output;
  const callPart: ToolCallPart = defined({
    type: "tool-call" as const,
    id: call.id,
    name: call.name,
    arguments: JSON.stringify(call.args),
    input: call.args,
    state: states.call,
    approval: states.approval
      ? { id: `${call.id}:approval`, needsApproval: true, approved: false }
      : undefined,
    output,
    metadata: {
      abacus: defined({
        segmentId,
        endpoint: call.endpoint,
        status: call.status,
        legacy: tool.legacy,
      }),
    },
  });
  if (result === undefined && !states.synthesise) return [callPart, undefined];

  const error =
    result === undefined ? states.syntheticError : str(result.error);
  const resultPart: ToolResultPart = defined({
    type: "tool-result" as const,
    id: `${segmentId}:result`,
    toolCallId: call.id,
    content: result === undefined ? "" : (str(result.output) ?? ""),
    state: states.result,
    outcome: states.outcome,
    error: states.result === "error" ? error : undefined,
    metadata: {
      abacus: defined({
        data: result?.data,
        rejection: result?.rejection,
      }),
    },
  });
  return [callPart, resultPart];
};

// ─── The mapper ──────────────────────────────────────────────────────────────

interface OpenBracket {
  part: SubagentPart;
  child: Target;
}

/**
 * Maps a v1 file's `segments` to UI messages. Total: any value in the array
 * maps to something, and the result depends only on the input.
 */
export function v1ToUiMessages(segments: readonly unknown[]): UIMessage[] {
  const messages: UIMessage[] = [];
  let assistant: Target | null = null;
  let open: OpenBracket | null = null;
  // Message ids must be unique in a thread (keys, `before` cursors); a
  // bracket's id also names its unmatched close, and corrupt data repeats ids.
  const usedIds = new Set<string>();
  const claim = (id: string): string => {
    let unique = id;
    for (let n = 1; usedIds.has(unique); n++) unique = `${id}:${n}`;
    usedIds.add(unique);
    return unique;
  };

  /**
   * The current assistant message, or a new one: after a user message, or
   * when the segment carries a `messageIndex` other than the message's.
   */
  const ensureAssistant = (segment: Rec, id: string): Target => {
    const messageIndex = num(segment.messageIndex);
    if (
      assistant !== null &&
      messageIndex !== undefined &&
      assistant.abacus.messageIndex !== undefined &&
      assistant.abacus.messageIndex !== messageIndex
    )
      assistant = null;
    if (assistant === null) {
      assistant = newTarget(claim(id), "assistant");
      messages.push(assistant.message);
    }
    takeTurnFields(assistant, segment);
    return assistant;
  };

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

  const closeBracket = (
    outcome: "completed" | "interrupted",
    close?: { entry: SegmentProvenance; endTime: number | undefined }
  ): void => {
    if (open === null) return;
    const subagent = open.part.subagent;
    if (outcome === "interrupted") {
      subagent.status = "error";
      subagent.error = { message: "interrupted" };
    } else {
      subagent.status = "finished";
    }
    if (close !== undefined) {
      const abacus = (subagent.metadata as { abacus: Rec }).abacus;
      if (close.endTime !== undefined) abacus.endTime = close.endTime;
      abacus.segments = [defined(close.entry)];
    }
    open = null;
  };

  const handleSubtask = (
    segment: Rec,
    id: string,
    groupId?: string
  ): boolean => {
    const status = str(segment.status);
    const at = num(segment.at);
    if (status === "created") {
      // A new bracket while one is open is a hand-back.
      closeBracket("completed");
      const target = ensureAssistant(segment, id);
      const child = newTarget(claim(`${id}:0`), "assistant");
      const part: SubagentPart = {
        type: "subagent",
        subagent: defined({
          id,
          name: str(segment.kind) ?? "delegate",
          description: str(segment.description),
          status: "running" as const,
          messages: [child.message],
          metadata: {
            abacus: defined({ startTime: num(segment.startTime) }),
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
      };
      if (open !== null) {
        // Frames written before `outcome` existed only ever meant finished.
        closeBracket(outcome === "interrupted" ? "interrupted" : "completed", {
          entry,
          endTime: num(segment.endTime),
        });
      } else {
        // Unmatched close: ignored, but still traceable.
        record(ensureAssistant(segment, id), entry);
      }
      return true;
    }
    return false;
  };

  const mapInto = (
    target: Target,
    segment: Rec,
    id: string,
    type: string | undefined,
    groupId: string | undefined
  ): void => {
    const at = num(segment.at);
    const base = { id, type: type ?? "unknown", at, groupId };
    const add = (part: MessagePart, extra: Partial<SegmentProvenance> = {}) =>
      record(target, { ...base, ...extra, partIndex: pushPart(target, part) });

    switch (type) {
      case "text": {
        const content = str(segment.content);
        if (content === undefined) break;
        add({ type: "text", content, metadata: { abacus: { segmentId: id } } });
        return;
      }
      case "thinking": {
        const content = str(segment.content);
        if (content === undefined) break;
        const part: ThinkingPart = { type: "thinking", content, stepId: id };
        add(part, { title: str(segment.title) });
        return;
      }
      case "collapsible": {
        const content = str(segment.content);
        if (content === undefined) break;
        add(
          kindText(content, id, "collapsible", { title: str(segment.title) })
        );
        return;
      }
      case "tool_call": {
        const tool = canonicalTool(segment, id);
        if (tool === null) break;
        const [call, result] = toolParts(id, tool);
        add(call);
        if (result !== undefined) pushPart(target, result);
        return;
      }
      case "notification": {
        const message = str(segment.message);
        if (message === undefined) break;
        add(
          kindText(message, id, "notification", {
            severity: str(segment.severity) ?? "info",
            actions: Array.isArray(segment.actions)
              ? segment.actions
              : undefined,
            notificationKey: str(segment.notificationKey),
          })
        );
        return;
      }
      case "credits": {
        const creditsUsed = num(segment.creditsUsed);
        if (creditsUsed === undefined) break;
        (target.abacus.credits ??= []).push({ segmentId: id, creditsUsed });
        record(target, { ...base, partIndex: null });
        return;
      }
      case "web_search_results": {
        const query = str(segment.query);
        if (query === undefined || !Array.isArray(segment.results)) break;
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
          add(part);
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
          add(part);
          return;
        }
        break;
      }
      case "feature_limit": {
        const featureName = str(segment.featureName);
        if (featureName === undefined) break;
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
    add(kindText("", id, "unknown", { raw: segment }));
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
      const target = open?.child ?? ensureAssistant(segment, id);
      target.message.parts.push(kindText("", id, "unknown", { raw: value }));
      record(target, {
        id,
        type: "unknown",
        partIndex: target.message.parts.length - 1,
        groupId,
      });
      return;
    }

    if (type === "text" && segment.source === "user") {
      // Cannot occur inside a bracket in v1 output; if it does, it closes it.
      closeBracket("completed");
      const user = newTarget(claim(id), "user");
      takeTurnFields(user, segment);
      messages.push(user.message);
      mapInto(user, segment, id, type, groupId);
      assistant = null;
      return;
    }

    if (type === "subtask" && handleSubtask(segment, id, groupId)) return;

    if (type === "tool_group" && Array.isArray(segment.tools)) {
      const target = open?.child ?? ensureAssistant(segment, id);
      record(target, {
        id,
        type,
        at: num(segment.at),
        partIndex: null,
        groupId,
        category: str(segment.category),
        summary: str(segment.summary),
      });
      segment.tools.forEach((member, index) =>
        handle(member, `${id}:${index}`, id)
      );
      return;
    }

    const target = open?.child ?? ensureAssistant(segment, id);
    mapInto(target, segment, id, type, groupId);
  };

  segments.forEach((segment, index) => handle(segment, `segment-${index}`));
  // History is never live: an unclosed bracket was interrupted.
  closeBracket("interrupted");
  return messages;
}
