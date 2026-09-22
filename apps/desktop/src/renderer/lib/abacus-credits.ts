import type { AbacusAccountInfo } from "#shared/contracts";

/** The plan-selection page, for a paid tier that wants more. */
export const ABACUS_PLAN_URL = "https://apps.abacus.ai/chatllm/choose-plan/";

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

  return "paid";
};
