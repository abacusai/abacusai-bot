import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { expect, it } from "vitest";

import { PROMO_SNOOZE_MS, promoAccountKey, promoState } from "./promo-state";
const free = {
  user_id: "dummy-a",
  organization_id: "dummy-org",
  subscription_tier: "free",
  credits_granted: 100,
  credits_used: 10,
} as AbacusAccountInfo;
it("preserves free-account eligibility and hides paid or unknown accounts", () => {
  for (const subscription_tier of ["basic", "pro", "", null])
    expect(
      promoState({ ...free, subscription_tier }, null, null, 100)
    ).toBeNull();
  expect(promoState(null, null, null, 100)).toBeNull();
  expect(promoState(free, null, null, 100)).toBe("upsell");
});
it("remembers snooze for ten minutes and reappears when credits run out", () => {
  const snooze = {
    until: 100 + PROMO_SNOOZE_MS,
    situation: "upsell" as const,
  };
  expect(promoState(free, null, snooze, 101)).toBeNull();
  expect(promoState(free, null, snooze, snooze.until)).toBe("upsell");
  expect(promoState({ ...free, credits_used: 100 }, null, snooze, 101)).toBe(
    "exhausted"
  );
  expect(
    promoState(
      { ...free, credits_used: 100 },
      null,
      { ...snooze, situation: "exhausted" },
      101
    )
  ).toBeNull();
});
it("scopes snooze to the account and organization", () => {
  expect(promoAccountKey(free)).not.toBe(
    promoAccountKey({ ...free, user_id: "dummy-b" })
  );
  expect(promoAccountKey(free)).not.toBe(
    promoAccountKey({ ...free, organization_id: "another-org" })
  );
});
