import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { isPayingAbacusTier } from "@abacus-ai/contract/models";

/** The plan a card should speak to. Unknown until the account is read. */
export type CreditsTier = "free" | "basic" | "paid" | "unknown";

export const accountTier = (account: AbacusAccountInfo | null | undefined) =>
  (account?.subscription_tier?.trim() || account?.plan?.trim())?.toLowerCase();

export const creditsTier = (
  account: AbacusAccountInfo | null | undefined
): CreditsTier => {
  const tier = accountTier(account);

  if (tier == null || tier.length === 0) return "unknown";
  if (tier === "free") return "free";
  if (tier === "basic") return "basic";

  return isPayingAbacusTier(tier) ||
    ["paid", "premium", "team", "enterprise", "business"].includes(tier)
    ? "paid"
    : "unknown";
};

export const CREDITS_EXHAUSTED_TTL_MS = 24 * 60 * 60 * 1000;
export const creditMarkState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  now: number,
  fresh: boolean
): "show" | "clear" | "hide" => {
  if (mark === null) return "hide";
  if (
    now - mark >= CREDITS_EXHAUSTED_TTL_MS ||
    creditsTier(account) === "paid" ||
    (fresh &&
      account?.credits_granted != null &&
      account.credits_used != null &&
      account.credits_used < account.credits_granted)
  )
    return "clear";
  return creditsTier(account) === "free" ? "show" : "hide";
};

/** Counters can establish exhaustion even without a turn's local mark. */
export const creditsCardState = (
  account: AbacusAccountInfo | null | undefined,
  mark: number | null,
  dismissed: boolean,
  now: number
): "exhausted" | "upsell" | null => {
  const tier = creditsTier(account);
  if (tier === "unknown" || tier === "basic") return null;
  const liveMark = mark != null && now - mark < CREDITS_EXHAUSTED_TTL_MS;
  const spent =
    account?.credits_granted != null &&
    account.credits_granted > 0 &&
    account.credits_used != null &&
    account.credits_used >= account.credits_granted;
  if (liveMark || spent) return "exhausted";
  return tier === "paid" || dismissed ? null : "upsell";
};
