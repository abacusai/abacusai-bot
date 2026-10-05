/**
 * How a chat list stamps its rows (spec 03 P17): the time today, the day
 * before that, the weekday within six days, then a date (with the year when
 * it is not this year), as a phone's message list does. Ported verbatim
 * from the old renderer's `components/layout/session-list-utils.ts`
 * (`chatStamp`) and the bots tree's wording of it. The workspace tree's
 * compact ages ("17m") answer a different question: how stale, not when.
 */

/** A token; `formatChatStamp` words it. */
export type ChatStamp =
  | { kind: "time" }
  | { kind: "yesterday" }
  | { kind: "weekday" }
  | { kind: "date"; sameYear: boolean };

export const chatStamp = (
  at: number | null | undefined,
  now: number
): ChatStamp | null => {
  if (at == null || !Number.isFinite(at) || at <= 0) return null;

  const midnight = new Date(now);
  midnight.setHours(0, 0, 0, 0);
  const today = midnight.getTime();
  const day = 24 * 60 * 60 * 1000;

  // Ahead of "now" is a clock that moved, not a message from the future.
  if (at >= today) return { kind: "time" };
  if (at >= today - day) return { kind: "yesterday" };
  // A week back stops being "last Tuesday" and starts being a date.
  if (at >= today - 6 * day) return { kind: "weekday" };

  return {
    kind: "date",
    sameYear: new Date(at).getFullYear() === new Date(now).getFullYear(),
  };
};

/**
 * "1:25 PM" today, `yesterday` before that, then the weekday, then a date;
 * null when there is no time to show. `yesterday` is the caller's
 * translated word (the old tree used `workspace.yesterday`).
 */
export const formatChatStamp = (
  at: number | null | undefined,
  now: number,
  language: string,
  yesterday: string
): string | null => {
  const stamp = chatStamp(at, now);
  if (stamp == null || at == null) return null;
  const when = new Date(at);
  if (stamp.kind === "time")
    return when.toLocaleTimeString(language, {
      hour: "numeric",
      minute: "2-digit",
    });
  if (stamp.kind === "yesterday") return yesterday;
  return new Intl.DateTimeFormat(
    language,
    stamp.kind === "weekday"
      ? { weekday: "long" }
      : {
          month: "short",
          day: "numeric",
          ...(stamp.sameYear ? {} : { year: "numeric" }),
        }
  ).format(when);
};
