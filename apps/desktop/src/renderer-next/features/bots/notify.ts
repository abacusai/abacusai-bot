import { isCheckInRoutine } from "#next/lib/bots/check-in";
/**
 * The bots watcher (spec 03 §6.7, §17; spec 05 §23.3 "03's watcher"): what
 * a run's end or a new permission means for a bot. From main's lossless
 * `ai.runFinished` (never a table diff): unread, the `received`/`done`/
 * `failed` cues and the "done" OS notification; from a bot session entering
 * `waiting_permission`: the `needs-you` cue and notification. Every cue and
 * notification goes through the shared gates (`lib/notify.ts`: quiet hours,
 * per-bot level; the sound player: visible thread, coalescing).
 */
import type { Notifier } from "#next/lib/notify";
import type { Cue } from "#next/lib/sound";
import type { RunFinishedNotice } from "#shared/contract/ai";
import type { BotRow, RoutineRow, SessionRow } from "#shared/contract/rows";

import { react } from "./avatar";
import type { UnreadStore } from "./data/unread-store";

export interface BotsWatcherDeps {
  bots(): readonly BotRow[];
  routines(): readonly RoutineRow[];
  /** The thread is on screen in a focused window. */
  seen(threadId: string): boolean;
  unread: UnreadStore;
  play(cue: Cue, options: { threadId: string; botId: string }): void;
  notifier: Pick<Notifier, "notify">;
  labels: {
    done(bot: string): { title: string; body: string };
    needsYou(bot: string): { title: string; body: string };
  };
}

/** Which bot a thread belongs to, and whether it is a check-in run. */
const botOfThread = (
  owner: { kind: "bot"; botId: string } | null | undefined,
  routineId: string | null,
  routines: readonly RoutineRow[]
): { botId: string; checkIn: boolean } | null => {
  if (owner?.kind === "bot") return { botId: owner.botId, checkIn: false };
  if (routineId == null) return null;
  const routine = routines.find((row) => row.id === routineId);
  if (routine?.botId == null || !isCheckInRoutine(routine, routine.botId))
    return null;
  return { botId: routine.botId, checkIn: true };
};

export const handleRunFinished = (
  deps: BotsWatcherDeps,
  notice: RunFinishedNotice
): void => {
  const target = botOfThread(notice.owner, notice.routineId, deps.routines());
  if (target == null || notice.outcome === "cancelled") return;
  const bot = deps.bots().find((row) => row.id === target.botId);
  if (bot == null) return;
  const cueOptions = { threadId: notice.threadId, botId: bot.id };
  const spoke = notice.hasVisibleAssistantText;
  if (notice.outcome === "error") deps.play("failed", cueOptions);
  else if (target.checkIn) deps.play("done", cueOptions);
  else if (spoke) deps.play("received", cueOptions);

  if (deps.seen(notice.threadId))
    react(bot.id, notice.outcome === "error" ? "sad" : "happy");
  if (!deps.seen(notice.threadId)) deps.unread.mark(bot.id);

  if (notice.outcome === "success" && (spoke || target.checkIn)) {
    const copy = deps.labels.done(bot.name);
    deps.notifier.notify({
      kind: "done",
      dedupeKey: notice.runId,
      botId: bot.id,
      title: copy.title,
      body: copy.body,
      metadata: { sessionId: notice.threadId },
    });
  }
};

/**
 * Sessions whose turn just entered `waiting_permission` (a level, compared
 * with the previous snapshot), for the needs-you cue and notification.
 */
export const newlyWaiting = (
  previous: ReadonlyMap<string, string>,
  sessions: readonly SessionRow[]
): { next: Map<string, string>; entered: SessionRow[] } => {
  const next = new Map<string, string>();
  const entered: SessionRow[] = [];
  for (const session of sessions) {
    if (session.turn?.phase !== "waiting_permission") continue;
    next.set(session.id, session.turn.updatedAt);
    if (previous.get(session.id) !== session.turn.updatedAt)
      entered.push(session);
  }
  return { next, entered };
};

export const handleWaiting = (
  deps: BotsWatcherDeps,
  session: SessionRow
): void => {
  const target = botOfThread(session.owner, session.routineId, deps.routines());
  if (target == null || session.turn == null) return;
  const bot = deps.bots().find((row) => row.id === target.botId);
  if (bot == null) return;
  if (deps.seen(session.id)) react(bot.id, "surprised");
  deps.play("needs-you", { threadId: session.id, botId: bot.id });
  const copy = deps.labels.needsYou(bot.name);
  deps.notifier.notify({
    kind: "needs-you",
    dedupeKey: `${session.id}:${session.turn.updatedAt}`,
    botId: bot.id,
    title: copy.title,
    body: copy.body,
    metadata: { sessionId: session.id, workspaceId: session.workspaceId },
  });
};

/** Connector requests are actionable even while the turn still streams. */
export const handleConnectorAsk = (
  deps: BotsWatcherDeps,
  session: SessionRow,
  requestId: string
): void => {
  const target = botOfThread(session.owner, session.routineId, deps.routines());
  if (!target) return;
  const bot = deps.bots().find((row) => row.id === target.botId);
  if (!bot) return;
  if (deps.seen(session.id)) react(bot.id, "surprised");
  deps.play("needs-you", { threadId: session.id, botId: bot.id });
  const copy = deps.labels.needsYou(bot.name);
  deps.notifier.notify({
    kind: "needs-you",
    dedupeKey: requestId,
    botId: bot.id,
    ...copy,
    metadata: { sessionId: session.id, workspaceId: session.workspaceId },
  });
};
