import type { AbacusAccountInfo } from "#shared/contracts";

/** The plan-selection page, for a paid tier that wants more. */
/** Where Upgrade goes: the product page, so people see what they get before a plan picker. */
export const ABACUS_PLAN_URL = "https://agent.abacus.ai/";

/** Where a Pro account tops up, rather than the plan chooser it has used. */
export const ABACUS_BUY_CREDITS_URL =
  "https://apps.abacus.ai/chatllm/admin/profile?buyCredits=true";

/** The plan a card should speak to. Unknown until the account is read. */
export type CreditsTier = "free" | "basic" | "paid" | "unknown";

export const creditsTier = (
  account: AbacusAccountInfo | null | undefined
): CreditsTier => {
  const tier = account?.subscription_tier?.trim().toLowerCase();

  if (tier == null || tier.length === 0) return "unknown";
  if (tier === "free") return "free";
  if (tier === "basic") return "basic";

  return ["paid", "pro", "premium", "team", "enterprise", "business"].includes(
    tier
  )
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
