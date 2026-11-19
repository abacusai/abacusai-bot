import { fireEvent, render, screen } from "@testing-library/react";
import { beforeAll, describe, expect, it, vi } from "vitest";

import { initI18n } from "#renderer/lib/i18n";

import { galleryStreak, STREAK_GALLERY_NOW } from "./gallery";
import { StreakCard } from "./streak-card";
import { StreakChipView } from "./streak-chip";

beforeAll(() => initI18n());

describe("StreakCard", () => {
  it.each([
    [
      "day-1",
      "Day 1 of your streak",
      "Come back tomorrow for 100 more credits.",
      "6 more days to the +500 full-week bonus.",
    ],
    [
      "mid-week",
      "3-day streak!",
      "Come back tomorrow for 100 more credits.",
      "4 more days to the +500 full-week bonus.",
    ],
    [
      "missed",
      "2-day streak!",
      "Come back tomorrow for 100 more credits.",
      null,
    ],
    [
      "restart",
      "New streak started",
      "Come back tomorrow for 100 more credits.",
      null,
    ],
    ["last-day", "3-day streak!", "Today counts. Nice work.", null],
    [
      "full-week",
      "A full week!",
      "+500 bonus credits added to your balance.",
      null,
    ],
  ] as const)("%s", (state, title, body, bonus) => {
    const onClose = vi.fn();
    const { container } = render(
      <StreakCard
        streak={galleryStreak(state)}
        now={STREAK_GALLERY_NOW}
        onClose={onClose}
      />
    );
    expect(screen.getByText(title)).toBeTruthy();
    expect(screen.getByText(body)).toBeTruthy();
    expect(container.textContent?.includes("full-week bonus")).toBe(
      bonus != null
    );
    if (bonus != null) expect(screen.getByText(bonus)).toBeTruthy();
    fireEvent.click(screen.getByText("Got it"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("StreakChipView", () => {
  it("shows today's credits left, and the best run only once it beats this one", async () => {
    render(
      <StreakChipView
        streak={galleryStreak("restart")}
        now={STREAK_GALLERY_NOW}
        defaultOpen
      />
    );
    expect(screen.getByText("100 credits for today")).toBeTruthy();
    expect(await screen.findByText("Best: 2 days")).toBeTruthy();
  });

  it("leaves the best run out while this one is it", async () => {
    render(
      <StreakChipView
        streak={galleryStreak("mid-week")}
        now={STREAK_GALLERY_NOW}
        defaultOpen
      />
    );
    expect(
      await screen.findByText(
        "+500 bonus credits for a full week · 4 days to go"
      )
    ).toBeTruthy();
    expect(screen.queryByText(/^Best:/)).toBeNull();
  });

  it("leaves today's credits off the chip once they are spent", () => {
    const { container } = render(
      <StreakChipView
        streak={galleryStreak("last-day")}
        now={STREAK_GALLERY_NOW}
      />
    );
    expect(container.textContent).toBe("3-day streak");
  });
});
