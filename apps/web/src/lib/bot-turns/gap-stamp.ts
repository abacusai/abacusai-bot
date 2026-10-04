/**
 * Time stamps between bot messages (spec 03 §11.3, parity P57): after a quiet
 * gap of 15 minutes. The chat kit already draws a day separator where the
 * local day changes (and before the first dated message), so a gap stamp is
 * only drawn inside one day.
 */

/** The gap that means you left and came back. */
export const QUIET_GAP_MS = 15 * 60 * 1000;

const sameLocalDay = (a: Date, b: Date): boolean =>
  a.getFullYear() === b.getFullYear() &&
  a.getMonth() === b.getMonth() &&
  a.getDate() === b.getDate();

/** Whether a stamp goes before `next`, given the previous shown message. */
export function gapStamp(prev: Date | null, next: Date | null): boolean {
  if (prev == null || next == null) return false;
  if (!sameLocalDay(prev, next)) return false;
  return next.getTime() - prev.getTime() >= QUIET_GAP_MS;
}

/** "Yesterday 1:22 PM": the day only when it is not today. */
export function stampLabel(
  at: Date,
  now: Date,
  locale: string | undefined,
  yesterday: string
): string {
  const time = at.toLocaleTimeString(locale, {
    hour: "numeric",
    minute: "2-digit",
  });
  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const dayBefore = midnight.getTime() - 24 * 60 * 60 * 1000;
  const ms = at.getTime();
  if (ms >= midnight.getTime()) return time;
  if (ms >= dayBefore) return `${yesterday} ${time}`;
  const withinWeek = ms >= midnight.getTime() - 6 * 24 * 60 * 60 * 1000;
  const day = at.toLocaleDateString(
    locale,
    withinWeek ? { weekday: "long" } : { month: "short", day: "numeric" }
  );
  return `${day} ${time}`;
}

/** When a message was created (`createdAt`, else `metadata.tanstack.createdAt`). */
export function messageTime(message: {
  createdAt?: Date | string;
  metadata?: unknown;
}): Date | null {
  if (message.createdAt != null) {
    const date = new Date(message.createdAt);
    if (!Number.isNaN(date.getTime())) return date;
  }
  const iso = (
    message.metadata as { tanstack?: { createdAt?: string } } | undefined
  )?.tanstack?.createdAt;
  if (typeof iso === "string") {
    const date = new Date(iso);
    if (!Number.isNaN(date.getTime())) return date;
  }
  return null;
}
