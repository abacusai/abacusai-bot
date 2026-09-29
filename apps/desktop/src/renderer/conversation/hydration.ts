/** Pure mapping from agent-owned persisted segments to renderer segments. */
import type { ConversationSegment, ToolCall, ToolResult } from "./agent-types";
import type { Segment, SubtaskKind, SubtaskStatus } from "./types";
import { createTool } from "./types";

export function conversationSegmentsToSegments(
  source: ConversationSegment[],
  options: {
    /** Mid-turn: an unclosed bracket is still open, not lost. */
    live?: boolean;
  } = {}
): Segment[] {
  const out: Segment[] = [];
  // Rebuild sub-agent scope from the persisted `super_agent_task` brackets:
  // `created` opens a card, `completed` closes it, and everything in between
  // is tagged with the bracket id (membership is positional, doc §9).
  let activeSubtaskId: string | null = null;
  for (const seg of source) {
    if (seg.type === "subtask") {
      // Timings are optional on the persisted frames.
      const timing = seg as {
        startTime?: number;
        endTime?: number;
        kind?: SubtaskKind;
        outcome?: SubtaskStatus;
      };
      if (seg.status === "created") {
        // A new bracket while one is open is a hand-back: close the previous.
        if (activeSubtaskId !== null) finalizeSubtask(out, activeSubtaskId);
        activeSubtaskId = seg.id;
        out.push({
          id: seg.id,
          status: "completed",
          source: "bot",
          type: "subtask",
          subtaskRef: seg.id,
          subtaskStatus: "running",
          ...(seg.description !== undefined && {
            description: seg.description,
          }),
          ...(timing.kind !== undefined && { subtaskKind: timing.kind }),
          ...(timing.startTime !== undefined && {
            subtaskStartTime: timing.startTime,
          }),
        });
      } else if (activeSubtaskId !== null) {
        // Frames written before `outcome` existed only ever meant "finished".
        finalizeSubtask(
          out,
          activeSubtaskId,
          timing.outcome ?? "completed",
          timing.endTime
        );
        activeSubtaskId = null;
      }
      continue;
    }
    const before = out.length;
    appendHydrated(out, seg);
    if (activeSubtaskId !== null) {
      for (let i = before; i < out.length; i++) {
        const child = out[i];
        if (child) out[i] = { ...child, subtaskId: activeSubtaskId };
      }
    }
  }
  // Hydrated history is static, so an unclosed bracket would spin forever;
  // settle it as interrupted. Unless the turn is still going: then the live
  // stream is about to close it.
  if (activeSubtaskId !== null && options.live !== true)
    finalizeSubtask(out, activeSubtaskId, "interrupted");
  return out;
}

/** Settle the still-running SubtaskSegment for `subtaskRef`. */
function finalizeSubtask(
  out: Segment[],
  subtaskRef: string,
  subtaskStatus: SubtaskStatus = "completed",
  subtaskEndTime?: number
): void {
  for (let i = out.length - 1; i >= 0; i--) {
    const seg = out[i];
    if (
      seg &&
      seg.type === "subtask" &&
      seg.subtaskRef === subtaskRef &&
      seg.subtaskStatus === "running"
    ) {
      out[i] = {
        ...seg,
        subtaskStatus,
        ...(subtaskEndTime !== undefined && { subtaskEndTime }),
      };
      return;
    }
  }
}

function completedHistoricalResult(
  toolCall: ToolCall,
  result: ToolResult | undefined
): ToolResult {
  return (
    result ?? {
      toolCallId: toolCall.id,
      output: " ",
      data: { type: "generic", output: " " },
    }
  );
}

function appendHydrated(out: Segment[], seg: ConversationSegment): void {
  switch (seg.type) {
    case "text":
      out.push({
        id: seg.id,
        status: "completed",
        source: seg.source,
        type: "text",
        content: seg.content,
        ...(seg.messageIndex !== undefined && {
          messageIndex: seg.messageIndex,
        }),
        ...(seg.regenerateAttempt !== undefined && {
          regenerateAttempt: seg.regenerateAttempt,
        }),
        ...(seg.versions !== undefined && { versions: seg.versions }),
      });
      return;
    case "thinking":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "thinking",
        content: seg.content,
        isSpinny: false,
        ...(seg.title !== undefined && { title: seg.title }),
      });
      return;
    case "collapsible":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "collapsible",
        content: seg.content,
        isSpinny: false,
        ...(seg.title !== undefined && { title: seg.title }),
      });
      return;
    case "tool_call": {
      const toolCall = seg.toolCall;
      if (!toolCall || toolCall.name === "") return;
      const toolResult = completedHistoricalResult(toolCall, seg.toolResult);
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "tool_call",
        tool: createTool(
          {
            ...toolCall,
            status: toolCall.status ?? "success",
            args:
              toolCall.args !== null && typeof toolCall.args === "object"
                ? toolCall.args
                : {},
          },
          toolResult
        ),
      });
      return;
    }
    case "notification":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "notification",
        message: seg.message,
        severity: seg.severity,
        ...(seg.actions !== undefined && { actions: seg.actions }),
        ...(seg.notificationKey !== undefined && {
          notificationKey: seg.notificationKey,
        }),
      });
      return;
    case "credits":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "credits",
        creditsUsed: seg.creditsUsed,
      });
      return;
    case "web_search_results":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "web_search_results",
        query: seg.query,
        resultType: seg.resultType,
        results: seg.results,
      });
      return;
    case "media":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "media",
        media: seg.media,
      });
      return;
    case "feature_limit":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "feature_limit",
        featureName: seg.featureName,
        limitType: seg.limitType,
      });
      return;
    case "compaction":
      out.push({
        id: seg.id,
        status: "completed",
        source: "bot",
        type: "compaction",
        compactionSummary: seg.summary,
      });
      return;
    case "tool_group":
      for (const tool of seg.tools) appendHydrated(out, tool);
      return;
    default:
      return;
  }
}
