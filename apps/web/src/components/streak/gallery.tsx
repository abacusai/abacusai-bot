import type { AbacusStreak } from "@abacus-ai/contract/contracts";

import { StreakCard } from "./streak-card";
import { StreakChipView } from "./streak-chip";

export const STREAK_GALLERY_STATES = [
  "day-1",
  "mid-week",
  "missed",
  "restart",
  "last-day",
  "full-week",
] as const;

export type StreakGalleryState = (typeof STREAK_GALLERY_STATES)[number];

export const STREAK_GALLERY_NOW = Date.parse("2026-11-19T15:00:00Z");
const ENDS = "2026-11-20T00:00:00+00:00";

const STREAKS: Record<StreakGalleryState, AbacusStreak> = {
  "day-1": {
    day: 1,
    streak: 1,
    best: 1,
    today_done: true,
    week: ["done", "later", "later", "later", "later", "later", "later"],
    daily_credits: 100,
    today_credits_left: 82,
    bonus_credits: 500,
    bonus_state: "pending",
    bonus_in_days: 6,
    day_ends_at: ENDS,
  },
  "mid-week": {
    day: 3,
    streak: 3,
    best: 3,
    today_done: true,
    week: ["done", "done", "done", "later", "later", "later", "later"],
    daily_credits: 100,
    today_credits_left: 64,
    bonus_credits: 500,
    bonus_state: "pending",
    bonus_in_days: 4,
    day_ends_at: ENDS,
  },
  missed: {
    day: 3,
    streak: 2,
    best: 2,
    today_done: true,
    week: ["missed", "done", "done", "later", "later", "later", "later"],
    daily_credits: 100,
    today_credits_left: 40,
    bonus_credits: 500,
    bonus_state: "missed",
    bonus_in_days: null,
    day_ends_at: ENDS,
  },
  restart: {
    day: 4,
    streak: 1,
    best: 2,
    today_done: true,
    week: ["done", "done", "missed", "done", "later", "later", "later"],
    daily_credits: 100,
    today_credits_left: 100,
    bonus_credits: 500,
    bonus_state: "missed",
    bonus_in_days: null,
    day_ends_at: ENDS,
  },
  "last-day": {
    day: 7,
    streak: 3,
    best: 4,
    today_done: true,
    week: ["done", "done", "done", "missed", "done", "done", "done"],
    daily_credits: 100,
    today_credits_left: 0,
    bonus_credits: 500,
    bonus_state: "missed",
    bonus_in_days: null,
    day_ends_at: ENDS,
  },
  "full-week": {
    day: 7,
    streak: 7,
    best: 7,
    today_done: true,
    week: ["done", "done", "done", "done", "done", "done", "done"],
    daily_credits: 100,
    today_credits_left: 55,
    bonus_credits: 500,
    bonus_state: "added",
    bonus_in_days: null,
    day_ends_at: ENDS,
  },
};

/** The home chip with its panel open, and the card under a reply, for one day of the week. */
export const StreakGallery = ({ state }: { state: StreakGalleryState }) => (
  <div className="flex flex-col gap-10 p-6">
    <div className="flex h-[440px] flex-col items-center">
      <StreakChipView
        streak={STREAKS[state]}
        now={STREAK_GALLERY_NOW}
        defaultOpen
      />
    </div>
    <StreakCard
      streak={STREAKS[state]}
      now={STREAK_GALLERY_NOW}
      onClose={() => undefined}
    />
  </div>
);
