/**
 * One gate for sounds and OS notifications (spec 05 §23.2, §23.3; built in
 * phase 3 for the bots watcher, which 05 names as its first consumer):
 * quiet hours and the per-bot level, then — for notifications — focus, the
 * user's switch and per-document dedupe.
 */
import type {
  BotSoundLevel,
  PrefsRow,
  QuietHours,
} from "#shared/contract/rows";

export type AttentionKind =
  | "needs-you"
  | "done"
  | "failed"
  | "received"
  | "routine-fired"
  | "sent";

const minutesOf = (hhmm: string): number | null => {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm);
  if (match == null) return null;
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (hours > 23 || minutes > 59) return null;
  return hours * 60 + minutes;
};

/** Local wall clock; `start > end` spans midnight; equal bounds are never quiet. */
export const isQuietNow = (
  quiet: QuietHours | undefined,
  now: Date
): boolean => {
  if (quiet?.enabled !== true) return false;
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start == null || end == null || start === end) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return start < end
    ? current >= start && current < end
    : current >= start || current < end;
};

export const allowed = (
  kind: AttentionKind,
  ctx: { botId: string | null; now: Date; sounds: PrefsRow["sounds"] }
): boolean => {
  if (isQuietNow(ctx.sounds.quietHours, ctx.now)) return false;
  if (ctx.botId == null) return true;
  const level: BotSoundLevel = ctx.sounds.perBot?.[ctx.botId] ?? "all";
  if (level === "nothing") return false;
  if (level === "needs-me") return kind === "needs-you";
  return true;
};

export interface NotifyDeps {
  isWindowFocused(): boolean;
  /** `settings.notifications.enabled`; unknown counts as on. */
  notificationsEnabled(): boolean;
  sounds(): PrefsRow["sounds"];
  now(): Date;
  send(input: {
    title: string;
    body: string;
    metadata?: { workspaceId?: string; sessionId?: string };
  }): Promise<unknown>;
}

export interface AttentionNotice {
  kind: "needs-you" | "done" | "failed";
  dedupeKey: string;
  botId: string | null;
  title: string;
  body: string;
  metadata: { sessionId: string; workspaceId?: string };
}

const DEDUPE_CAP = 500;

/** A per-document notifier; `notify` returns whether it sent. */
export const createNotifier = (deps: NotifyDeps, seen = new Set<string>()) => {
  return {
    notify(notice: AttentionNotice): boolean {
      if (deps.isWindowFocused()) return false;
      if (!deps.notificationsEnabled()) return false;
      if (
        !allowed(notice.kind, {
          botId: notice.botId,
          now: deps.now(),
          sounds: deps.sounds(),
        })
      )
        return false;
      if (seen.has(notice.dedupeKey)) return false;
      seen.add(notice.dedupeKey);
      if (seen.size > DEDUPE_CAP)
        seen.delete(seen.values().next().value as string);
      void deps
        .send({
          title: notice.title,
          body: notice.body,
          metadata: notice.metadata,
        })
        .catch(() => undefined);
      return true;
    },
  };
};

export type Notifier = ReturnType<typeof createNotifier>;

/** Call the owning document notifier; all gates are centralized here. */
export const notifyAttention = (
  notifier: Notifier,
  notice: AttentionNotice
): boolean => notifier.notify(notice);
