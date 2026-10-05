import type { AbacusAccountInfo } from "#shared/contracts";
import { FREE_POOL_PROVIDERS } from "#shared/free-pool";
import { PROVIDER_KEY_FIELDS } from "#shared/settings";

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

const POOL_PROVIDERS = new Set<string>(["abacus", ...FREE_POOL_PROVIDERS]);
export const alternativeProviderLabels = (
  configured: Record<string, boolean>
) =>
  PROVIDER_KEY_FIELDS.filter(
    (field) =>
      field.kind === "model" &&
      !POOL_PROVIDERS.has(field.provider) &&
      configured[field.provider] === true
  ).map((field) => field.label);
export const joinProviderLabels = (labels: string[], or: string): string =>
  labels.length <= 1
    ? (labels[0] ?? "")
    : `${labels.slice(0, -1).join(", ")} ${or} ${labels[labels.length - 1]}`;
