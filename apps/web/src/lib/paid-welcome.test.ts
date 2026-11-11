import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  paidWelcomeDecision,
  registerPaidWelcome,
  welcomeLandedPlan,
  welcomeLastChat,
  welcomeLead,
} from "./paid-welcome";

const account = (tier: string): AbacusAccountInfo => ({
  user_id: "u",
  organization_id: "o",
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: 1,
  plan: tier,
  subscription_tier: tier,
  credits_granted: 100,
  credits_used: 0,
});

const marks = (
  freePlanSeenAt: number | null,
  paidWelcomeTier: string | null,
  upgradeRoutinesSeenAt: number | null = null
) => ({ freePlanSeenAt, paidWelcomeTier, upgradeRoutinesSeenAt });

describe("paidWelcomeDecision", () => {
  it.each([
    [
      "free read forgets the last welcome",
      marks(1, "basic", 1),
      "free",
      undefined,
      false,
      { paidWelcomeTier: null, upgradeRoutinesSeenAt: null },
    ],
    [
      "free read with nothing to forget",
      marks(1, null),
      "free",
      undefined,
      false,
      undefined,
    ],
    [
      "paid read after a free one",
      marks(1, null),
      "basic",
      undefined,
      true,
      { paidWelcomeTier: "basic" },
    ],
    [
      "the same tier again",
      marks(1, "basic"),
      "basic",
      undefined,
      false,
      undefined,
    ],
    [
      "basic moving up to pro",
      marks(1, "basic"),
      "pro",
      undefined,
      true,
      { paidWelcomeTier: "pro" },
    ],
    [
      "pro moving down to basic",
      marks(1, "pro"),
      "basic",
      undefined,
      false,
      { paidWelcomeTier: "basic" },
    ],
    [
      "a payer never seen free",
      marks(null, null),
      "pro",
      undefined,
      false,
      { paidWelcomeTier: "pro" },
    ],
    [
      "an older build's card already told it",
      marks(1, null, 1),
      "basic",
      undefined,
      false,
      { paidWelcomeTier: "basic" },
    ],
    [
      "a watched payment from free",
      marks(null, null),
      "basic",
      account("free"),
      true,
      { paidWelcomeTier: "basic" },
    ],
    [
      "a watched payment the passive read stamped first",
      marks(null, "basic"),
      "basic",
      account("free"),
      true,
      { paidWelcomeTier: "basic" },
    ],
    [
      "a top-up on the same tier",
      marks(null, "pro"),
      "pro",
      account("pro"),
      false,
      undefined,
    ],
    [
      "a watched next plan",
      marks(null, "basic"),
      "pro",
      account("basic"),
      true,
      { paidWelcomeTier: "pro" },
    ],
    ["an unread account", marks(1, null), "", undefined, false, undefined],
  ] as const)("%s", (_name, given, tier, from, show, write) => {
    const decision = paidWelcomeDecision(given, account(tier), from);
    expect(decision.show).toBe(show);
    expect(decision.write).toEqual(write);
  });
});

describe("welcomeLandedPlan", () => {
  it("sends the paused turn at once when no welcome takes it", () => {
    const resume = vi.fn(async () => undefined);
    welcomeLandedPlan(account("basic"), account("free"), {
      threadId: "t",
      paused: { resume },
    });
    expect(resume).toHaveBeenCalledOnce();
  });

  it("leaves the paused turn to a welcome that shows", () => {
    const resume = vi.fn(async () => undefined);
    const host = vi.fn(() => true);
    const unregister = registerPaidWelcome(host);
    welcomeLandedPlan(account("basic"), account("free"), {
      threadId: "t",
      paused: { text: "hi", resume },
    });
    unregister();
    expect(host).toHaveBeenCalledOnce();
    expect(resume).not.toHaveBeenCalled();
  });
});

describe("welcomeLead", () => {
  it.each([
    [{ paused: true, lastChat: true, topModel: true }, "paused"],
    [{ paused: true, lastChat: false, topModel: false }, "paused"],
    [{ paused: false, lastChat: true, topModel: true }, "chat"],
    [{ paused: false, lastChat: false, topModel: true }, "task"],
    [{ paused: false, lastChat: true, topModel: false }, "none"],
  ] as const)("%o leads with %s", (input, lead) => {
    expect(welcomeLead(input)).toBe(lead);
  });
});

describe("welcomeLastChat", () => {
  const now = Date.parse("2026-11-11T12:00:00Z");
  const at = (id: string, daysAgo: number) => ({
    id,
    updatedAt: new Date(now - daysAgo * 86_400_000).toISOString(),
  });
  it("picks the latest chat touched within a week", () => {
    expect(welcomeLastChat([at("a", 3), at("b", 1), at("c", 6)], now)?.id).toBe(
      "b"
    );
  });
  it("has nothing to pick up past a week, or with no chats", () => {
    expect(welcomeLastChat([at("old", 8)], now)).toBeNull();
    expect(welcomeLastChat([], now)).toBeNull();
  });
});
