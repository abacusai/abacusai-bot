/**
 * The sidebars' short timestamps (canvas `BotsSidebar`: "9:41", "Tue",
 * "Sep 3"): today as a time, the past week as a weekday, else a date.
 */
const DAY = 86_400_000;

export const formatWhen = (
  at: number | string,
  now: number,
  locale: string
): string => {
  const time = typeof at === "number" ? at : Date.parse(at);
  if (!Number.isFinite(time)) return "";
  const date = new Date(time);
  const today = new Date(now);
  if (date.toDateString() === today.toDateString())
    return new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  if (now - time < 6 * DAY)
    return new Intl.DateTimeFormat(locale, { weekday: "short" }).format(date);
  return new Intl.DateTimeFormat(locale, {
    month: "short",
    day: "numeric",
  }).format(date);
};
