import type { SessionRow } from "#shared/contract/rows";
export type SessionAttention =
  | { kind: "needs-you"; since: string; reason: "permission" | "connector" }
  | { kind: "running"; caption: string | null }
  | { kind: "error" }
  | { kind: "unread" }
  | { kind: "idle" };
export const sessionAttention = (
  row: Pick<SessionRow, "turn" | "status">,
  unread: boolean,
  pendingConnectorAsks: number,
  activity?: { caption: string | null }
): SessionAttention => {
  if (row.turn?.phase === "waiting_permission" || pendingConnectorAsks > 0)
    return {
      kind: "needs-you",
      since: row.turn?.updatedAt ?? "",
      reason: pendingConnectorAsks > 0 ? "connector" : "permission",
    };
  if (row.turn?.isBusy)
    return { kind: "running", caption: activity?.caption ?? null };
  if (row.turn?.phase === "error" || row.status === "error")
    return { kind: "error" };
  return { kind: unread ? "unread" : "idle" };
};
