/**
 * Quiet hours (prefs `sounds.quietHours`): the one reading of the user's
 * do-not-disturb window, for the renderer's sounds and notifications and for
 * main's chat-app sends.
 */
import type { QuietHours } from "./contract/rows";

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
