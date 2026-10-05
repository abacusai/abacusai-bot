import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";

import { isListedSession } from "#renderer/data/db/filters";
import type { Notifier } from "#renderer/lib/notify";
import type { SoundPlayer } from "#renderer/lib/sound";
export interface SessionsWatcherDeps {
  sessions(): readonly SessionRow[];
  seen(id: string): boolean;
  mark(id: string): void;
  player: Pick<SoundPlayer, "play">;
  notifier: Pick<Notifier, "notify">;
  labels: { done: string; needsYou: string };
}
const delivered = new Set<string>();
export const handleSessionRunFinished = (
  deps: SessionsWatcherDeps,
  notice: RunFinishedNotice
) => {
  const row = deps.sessions().find((s) => s.id === notice.threadId);
  if (
    !row ||
    !isListedSession(row) ||
    notice.outcome === "cancelled" ||
    delivered.has(notice.runId)
  )
    return;
  delivered.add(notice.runId);
  if (delivered.size > 2000) delivered.delete(delivered.values().next().value!);
  if (!deps.seen(row.id)) deps.mark(row.id);
  if (notice.outcome === "error")
    deps.player.play("failed", { threadId: row.id, dedupeKey: notice.runId });
  else if (notice.hasVisibleAssistantText) {
    deps.player.play("done", { threadId: row.id, dedupeKey: notice.runId });
    deps.notifier.notify({
      kind: "done",
      dedupeKey: notice.runId,
      botId: null,
      title: row.label,
      body: deps.labels.done,
      metadata: { workspaceId: row.workspaceId, sessionId: row.id },
    });
  }
};
export const notifySessionAsk = (
  deps: SessionsWatcherDeps,
  id: string,
  key: string
) => {
  const row = deps.sessions().find((s) => s.id === id);
  if (!row || !isListedSession(row)) return;
  deps.player.play("needs-you", { threadId: id, dedupeKey: key });
  deps.notifier.notify({
    kind: "needs-you",
    dedupeKey: key,
    botId: null,
    title: row.label,
    body: deps.labels.needsYou,
    metadata: { workspaceId: row.workspaceId, sessionId: id },
  });
};
