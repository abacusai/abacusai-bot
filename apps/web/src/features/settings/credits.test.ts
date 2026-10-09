import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { describe, it, expect } from "vitest";

import {
  creditMarkState,
  creditsTier,
  creditsCardState,
  CREDITS_EXHAUSTED_TTL_MS,
} from "./credits";
const account = (tier: string, used = 10, granted = 10) =>
  ({
    subscription_tier: tier,
    credits_used: used,
    credits_granted: granted,
  }) as AbacusAccountInfo;
describe("R5-T23 credits guards", () => {
  it.each(["go", "max", " Go ", "MAX"])(
    "recognizes the paying %s plan",
    (tier) => {
      expect(creditsTier(account(tier))).toBe("paid");
      expect(creditMarkState(account(tier), 1, 2, false)).toBe("clear");
      expect(creditsCardState(account(tier), null, false, 2)).toBe("exhausted");
      expect(creditsCardState(account(tier, 1, 10), null, false, 2)).toBeNull();
    }
  );
  it("requires a read free account and a live mark", () => {
    expect(creditMarkState(undefined, 1, 2, false)).toBe("hide");
    expect(creditMarkState(account("free"), 1, 2, false)).toBe("show");
    expect(creditMarkState(account("basic"), 1, 2, false)).toBe("hide");
    expect(creditMarkState(account("unknown"), 1, 2, false)).toBe("hide");
    expect(creditMarkState(account("unrecognized-tier"), 1, 2, false)).toBe(
      "hide"
    );
  });
  it("clears paid, expired and fresh headroom marks", () => {
    expect(creditMarkState(account("pro"), 1, 2, false)).toBe("clear");
    expect(
      creditMarkState(account("free"), 1, CREDITS_EXHAUSTED_TTL_MS + 1, false)
    ).toBe("clear");
    expect(creditMarkState(account("free", 1, 10), 1, 2, false)).toBe("show");
    expect(creditMarkState(account("free", 1, 10), 1, 2, true)).toBe("clear");
  });
});
