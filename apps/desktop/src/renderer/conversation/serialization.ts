/**
 * Renderer segments back to persistable ConversationSegments, the inverse of
 * `hydration.ts`. Persisting the wire shape keeps load on the exercised path.
 * Lossy by design: live-streaming state is dropped; `serialize → hydrate` is
 * idempotent.
 */
import type { ConversationSegment } from "./agent-types";
import type { Segment } from "./types";

/** Segments that only ever exist mid-stream and have nothing to restore. */
const isTransient = (seg: Segment): boolean =>
  seg.type === "pending" || (seg.type === "collapsible" && seg.temp === true);

/**
 * Every tool-ish segment carries the same canonical `tool`; hydration folds
 * them all back into `tool_call`, so that is what we persist.
 */
const toolCallSegment = (
  seg: Extract<Segment, { tool: unknown }>
): ConversationSegment | null => {
  const tool = seg?.tool;
  const call = tool?.call;
  if (call == null || call.name === "") return null;

  return {
    type: "tool_call",
    id: seg.id,
    toolCall: call,
    ...(tool?.result !== undefined && { toolResult: tool.result }),
  };
};

const baseFields = (
  seg: Segment
): Pick<
  Extract<ConversationSegment, { type: "text" }>,
  "messageIndex" | "regenerateAttempt" | "versions"
> => ({
  ...(seg?.messageIndex !== undefined && { messageIndex: seg.messageIndex }),
  ...(seg?.regenerateAttempt !== undefined && {
    regenerateAttempt: seg.regenerateAttempt,
  }),
  ...(seg?.versions !== undefined && { versions: seg.versions }),
});

const toConversationSegment = (seg: Segment): ConversationSegment | null => {
  switch (seg?.type) {
    case "text":
      return {
        type: "text",
        id: seg.id,
        source: seg.source === "user" ? "user" : "bot",
        content: seg.content ?? "",
        ...baseFields(seg),
      };
    case "thinking":
      return {
        type: "thinking",
        id: seg.id,
        content: seg.content ?? "",
        isSpinny: false,
        ...(seg.title !== undefined && { title: seg.title }),
      };
    case "collapsible":
      return {
        type: "collapsible",
        id: seg.id,
        content: seg.content ?? "",
        isSpinny: false,
        ...(seg.title !== undefined && { title: seg.title }),
      };
    case "tool_call":
    case "terminal_command":
    case "file_write":
    case "file_read":
      return toolCallSegment(seg);
    case "notification":
      return {
        type: "notification",
        id: seg.id,
        message: seg.message ?? "",
        severity: seg.severity,
        ...(seg.actions !== undefined && { actions: seg.actions }),
        ...(seg.notificationKey !== undefined && {
          notificationKey: seg.notificationKey,
        }),
      };
    case "credits":
      return { type: "credits", id: seg.id, creditsUsed: seg.creditsUsed ?? 0 };
    case "web_search_results":
      return {
        type: "web_search_results",
        id: seg.id,
        query: seg.query ?? "",
        resultType: seg.resultType,
        results: seg.results ?? [],
      };
    case "media":
      return { type: "media", id: seg.id, media: seg.media };
    case "feature_limit":
      return {
        type: "feature_limit",
        id: seg.id,
        featureName: seg.featureName,
        limitType: seg.limitType,
      };
    case "compaction":
      return {
        type: "compaction",
        id: seg.id,
        summary: seg.compactionSummary ?? "",
      };
    default:
      return null;
  }
};

/**
 * Flatten to the persistable form, re-deriving the positional
 * `super_agent_task` brackets hydration reads: `created` before the
 * sub-agent's segments, `completed` after.
 */
export function segmentsToConversationSegments(
  segments: Segment[]
): ConversationSegment[] {
  const out: ConversationSegment[] = [];
  let openSubtaskId: string | null = null;
  // Every settled bracket gets a closing frame with its real outcome; an
  // absent frame cannot distinguish "interrupted" from "still running when
  // saved".
  let openSubtaskOutcome: "completed" | "interrupted" | null = null;

  // So the closing frame can carry the end time; without it every historical
  // sub-agent reads as "took no time".
  let openSubtaskEndTime: number | undefined;

  const closeSubtask = (): void => {
    if (openSubtaskId == null) return;
    if (openSubtaskOutcome != null) {
      out.push({
        type: "subtask",
        id: openSubtaskId,
        status: "completed",
        outcome: openSubtaskOutcome,
        ...(openSubtaskEndTime !== undefined && {
          endTime: openSubtaskEndTime,
        }),
      } as ConversationSegment);
    }
    openSubtaskId = null;
    openSubtaskOutcome = null;
    openSubtaskEndTime = undefined;
  };

  for (const seg of segments ?? []) {
    if (seg == null || isTransient(seg)) continue;

    if (seg.type === "subtask") {
      // The card is the bracket; its members follow, tagged with `subtaskId`.
      closeSubtask();
      const ref = seg.subtaskRef ?? seg.id;
      out.push({
        type: "subtask",
        id: ref,
        status: "created",
        ...(seg.description !== undefined && { description: seg.description }),
        ...(seg.subtaskKind !== undefined && { kind: seg.subtaskKind }),
        ...(seg.subtaskStartTime !== undefined && {
          startTime: seg.subtaskStartTime,
        }),
      } as ConversationSegment);
      openSubtaskId = ref;
      openSubtaskOutcome =
        seg.subtaskStatus === "running" ? null : seg.subtaskStatus;
      openSubtaskEndTime = seg.subtaskEndTime;
      continue;
    }

    // A segment outside the open bracket closes it — membership is positional.
    if (openSubtaskId != null && seg.subtaskId !== openSubtaskId)
      closeSubtask();

    const converted = toConversationSegment(seg);
    if (converted != null) out.push(converted);
  }
  closeSubtask();

  return out;
}
