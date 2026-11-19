/**
 * The daily streak a new free account gets from the platform (GET /v1/account
 * `streak`): extra credits each day it is on, used before the others and gone
 * at the day's end, and a bonus for a full week of days. The platform decides
 * every number and when the streak is on; the app only shows what it is sent,
 * and shows nothing once it stops coming.
 */
import type { AbacusStreak, AbacusStreakDay } from "./contracts";

const STREAK_DAYS: readonly AbacusStreakDay[] = [
  "done",
  "missed",
  "today",
  "later",
];
const BONUS_STATES = ["pending", "added", "missed"] as const;

const count = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : null;

/** The platform's streak, or null for anything unreadable: no streak is shown then. */
export const parseStreak = (raw: unknown): AbacusStreak | null => {
  if (raw == null || typeof raw !== "object") return null;
  const value = raw as Record<string, unknown>;
  const day = count(value.day);
  const streak = count(value.streak);
  const best = count(value.best);
  const daily = count(value.daily_credits);
  const left = count(value.today_credits_left);
  const bonus = count(value.bonus_credits);
  const week = Array.isArray(value.week)
    ? value.week.filter((each): each is AbacusStreakDay =>
        STREAK_DAYS.includes(each as AbacusStreakDay)
      )
    : [];
  const bonusState = BONUS_STATES.find((state) => state === value.bonus_state);
  const endsAt =
    typeof value.day_ends_at === "string" &&
    Number.isFinite(Date.parse(value.day_ends_at))
      ? value.day_ends_at
      : null;
  if (
    day == null ||
    day < 1 ||
    streak == null ||
    best == null ||
    daily == null ||
    left == null ||
    bonus == null ||
    bonusState == null ||
    endsAt == null ||
    week.length === 0 ||
    week.length !== (value.week as unknown[]).length
  )
    return null;
  return {
    day,
    streak,
    best,
    today_done: value.today_done === true,
    week,
    daily_credits: daily,
    today_credits_left: Math.min(left, daily),
    bonus_credits: bonus,
    bonus_state: bonusState,
    bonus_in_days: bonusState === "pending" ? count(value.bonus_in_days) : null,
    day_ends_at: endsAt,
  };
};

/** The day's extra credits, while some are left and the day is not over. */
export const streakCreditsLeft = (
  streak: AbacusStreak | null | undefined,
  now: number
): number =>
  streak != null && Date.parse(streak.day_ends_at) > now
    ? streak.today_credits_left
    : 0;

/** The device's offset from UTC in minutes, east positive: what the platform counts days in. */
export const utcOffsetMinutes = (date = new Date()): number =>
  -date.getTimezoneOffset();

/** The user's local calendar day, `YYYY-MM-DD`. */
export const localDay = (now: number): string => {
  const date = new Date(now);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
};
