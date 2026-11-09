import { linkTimeLeft } from "@abacus-ai/contract/link-time-left";

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

/** Time left in the locale's own words: "6 days 23 hours", "2 hours 5 minutes", "20 minutes". */
export const formatTimeLeft = (ms: number, locale: string): string => {
  const { days, hours, minutes } = linkTimeLeft(ms);
  const units: Array<[number, "day" | "hour" | "minute"]> = [
    [days, "day"],
    [hours, "hour"],
    [minutes, "minute"],
  ];
  return new Intl.ListFormat(locale, { style: "narrow", type: "unit" }).format(
    units
      .filter(([value]) => value > 0)
      .map(([value, unit]) =>
        new Intl.NumberFormat(locale, {
          style: "unit",
          unit,
          unitDisplay: "long",
        }).format(value)
      )
  );
};

/** When a link stops working, for a day other than today: weekday, date and time. */
export const formatExpiryDate = (at: number, locale: string): string =>
  new Intl.DateTimeFormat(locale, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(at));
