import type {
  AttentionSummary,
  RunFinishedNotice,
} from "@abacus-ai/contract/contract";
export const permissionCueKey = (summary: AttentionSummary): string =>
  `${summary.threadId}:${summary.incarnation}:${summary.oldestAt}`;

export const cueForNotice = (
  notice: RunFinishedNotice,
  _ctx: { checkInRoutineIds: ReadonlySet<string> }
): { kind: "received" | "done" | "failed"; dedupeKey: string } | null => {
  if (notice.outcome === "cancelled") return null;
  if (notice.outcome === "error")
    return { kind: "failed", dedupeKey: notice.runId };
  if (notice.owner != null && notice.routineId == null)
    return notice.hasVisibleAssistantText
      ? { kind: "received", dedupeKey: notice.runId }
      : null;
  return { kind: "done", dedupeKey: notice.runId };
};
