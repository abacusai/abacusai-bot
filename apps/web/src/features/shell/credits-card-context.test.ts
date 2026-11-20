import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import type { CreditThresholdMark } from "@abacus-ai/contract/credit-thresholds";
import { expect, it } from "vitest";

import { creditsCardContext, creditsCardLevel } from "./credits-card-context";

const account = (
  used: number,
  tier = "free",
  extra: Partial<AbacusAccountInfo> = {}
): AbacusAccountInfo =>
  ({
    user_id: "u",
    organization_id: "o",
    subscription_tier: tier,
    credits_granted: 2000,
    credits_used: used,
    ...extra,
  }) as AbacusAccountInfo;

const mark = (
  extra: Partial<CreditThresholdMark> = {}
): CreditThresholdMark => ({
  reached: 80,
  at: 1,
  used: 1700,
  granted: 2000,
  perTask: 60,
  kind: "messages",
  told: null,
  plan: "free",
  ...extra,
});

it.each([
  [0, null],
  [999, null],
  [1000, 50],
  [1599, 50],
  [1600, 80],
  [1900, 95],
  [2000, 100],
  [2400, 100],
])("%i of 2000 used is level %s", (used, level) => {
  expect(creditsCardLevel(account(used))).toBe(level);
});

it("measures against the plan's own credits, as the milestones do", () => {
  expect(
    creditsCardLevel(
      account(2000, "free", { credits_granted: 3000, plan_credits: 2000 })
    )
  ).toBe(50);
});

it.each([
  ["under half", account(400), mark(), null],
  ["a paid plan", account(1700, "basic"), mark({ plan: "paid" }), null],
  [
    "the free plan with its mark",
    account(1700),
    mark(),
    {
      level: 80,
      project: "Invoice app",
      estimate: { count: 5, kind: "messages" },
    },
  ],
  [
    "a paid plan's mark",
    account(1700),
    mark({ plan: "paid" }),
    { level: 80, project: "Invoice app", estimate: null },
  ],
  [
    "less than one task left",
    account(1990),
    mark({ reached: 95, used: 1990 }),
    { level: 95, project: "Invoice app", estimate: null },
  ],
  [
    "used up",
    account(2000),
    mark({ reached: 95, used: 1990 }),
    { level: 100, project: "Invoice app", estimate: null },
  ],
])("%s", (_case, read, held, expected) => {
  expect(creditsCardContext(read, held, "Invoice app")).toEqual(expected);
});

it("leaves out a chat with no name", () => {
  expect(creditsCardContext(account(1000), undefined, "")).toEqual({
    level: 50,
    estimate: null,
  });
});
