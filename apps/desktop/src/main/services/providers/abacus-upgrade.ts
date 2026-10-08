import { credentialFor } from "../config/settings";
import { abacusApiCall } from "./abacus-connector-service";

/**
 * The account's own upgrade page: a one-time link the platform binds to the
 * signed-in user, live for 30 minutes (asking again while it is live returns
 * the same one). Null when the account has no upgrade offer, such as a paid
 * plan, when signed out, or when the call fails.
 */

/** Well inside the link's life, so a cached link is never a dead one. */
const UPGRADE_URL_TTL_MS = 60_000;

let cached: { key: string; url: string | null; at: number } | null = null;

export const fetchUpgradeUrl = async (): Promise<string | null> => {
  const key = credentialFor("ABACUS_API_KEY");
  if (key.length === 0) return null;
  if (
    cached != null &&
    cached.key === key &&
    Date.now() - cached.at < UPGRADE_URL_TTL_MS
  )
    return cached.url;
  const { ok, result } = await abacusApiCall(
    "_createAbacusbotUpgradeLink",
    "GET"
  );
  if (!ok) return null;
  const url =
    result != null && typeof result === "object"
      ? (result as Record<string, unknown>).url
      : null;
  const link =
    typeof url === "string" && url.startsWith("https://") ? url : null;
  cached = { key, url: link, at: Date.now() };
  return link;
};

/** A plan the account could be on: its price, monthly credits and what it gives. */
export interface BillingPlanTier {
  plan: string;
  planName: string;
  priceText: string;
  features: string[];
}

/** The account's plan, credits and ways up, as the platform reads them live. */
export interface BillingPlan {
  current: {
    planName: string;
    creditsRemaining: number | null;
    creditsGranted: number | null;
    freeTierExpiresAt: string | null;
  };
  plans: (BillingPlanTier & { creditsPerMonth: number; current: boolean })[];
  /** Each with the link to it, or null when it is bought in the mobile app. */
  upgrades: (BillingPlanTier & { url: string | null })[];
  topUpUrl: string | null;
  upgradeInMobileApp: boolean;
}

/**
 * The signed-in account's plan, credits and upgrade paths: a free account's
 * upgrades are its own one-time Basic and Pro links. Null when signed out,
 * when the platform offers none, or when the call fails.
 */
export const fetchBillingPlan = async (): Promise<BillingPlan | null> => {
  const { ok, result } = await abacusApiCall("_getAbacusbotBillingPlan", "GET");
  if (!ok || result == null || typeof result !== "object") return null;
  return result as BillingPlan;
};
