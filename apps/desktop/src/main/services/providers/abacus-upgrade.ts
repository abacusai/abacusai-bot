import { abacusPlanTier } from "@abacus-ai/contract/models";

import { credentialFor } from "../config/settings";
import { cachedAbacusAccount } from "./abacus";
import { abacusApiCall } from "./abacus-connector-service";
import { abacusAppHost } from "./abacus-host";

export type UpgradePlan = "basic" | "pro";

/** Where an upgrade link was given, for the platform's attribution. */
export type UpgradeSource = "app" | "channel" | "billing_plan" | "phone";

/**
 * The permanent upgrade page: it signs the user in and makes their checkout
 * itself, so opening it never waits on a call from here.
 */
export const upgradeLink = (plan: UpgradePlan, src: UpgradeSource): string => {
  const url = new URL("/bot/link/upgrade", abacusAppHost());
  url.searchParams.set("plan", plan);
  url.searchParams.set("src", src);
  // The account's owner, so a browser signed in to another account is asked to switch rather than paying for it.
  const owner = cachedAbacusAccount()?.upgrade_owner;
  if (owner != null) url.searchParams.set("u", owner);
  return url.toString();
};

/**
 * The app's Upgrade button: Basic for a free or unread account, Pro for Basic.
 * Null when signed out or on a higher paid plan (the plans page serves those).
 */
export const appUpgradeUrl = (): string | null => {
  if (credentialFor("ABACUS_API_KEY").length === 0) return null;
  const tier = abacusPlanTier(cachedAbacusAccount());
  if (tier === "paid") return null;
  return upgradeLink(tier === "basic" ? "pro" : "basic", "app");
};

/** A plan the account could be on: its price, monthly credits and what it gives. */
export interface BillingPlanTier {
  plan: string;
  planName: string;
  priceText: string;
  /** The first month's price and the monthly one, and what the first month is off (absent from older servers). */
  firstMonthPriceCents?: number;
  priceCents?: number;
  percentOff?: number;
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
 * The signed-in account's plan, credits and upgrade paths. An upgrade the
 * server sends without a link (older servers mint them only on request) gets
 * the permanent page. Null when signed out, when the platform offers none, or
 * when the call fails.
 */
export const fetchBillingPlan = async (
  src: "billing_plan" | "phone"
): Promise<BillingPlan | null> => {
  const { ok, result } = await abacusApiCall("_getAbacusbotBillingPlan", "GET");
  if (!ok || result == null || typeof result !== "object") return null;
  const billing = result as BillingPlan;
  if (billing.upgradeInMobileApp) return billing;
  return {
    ...billing,
    upgrades: billing.upgrades.map((upgrade) =>
      upgrade.url != null
        ? upgrade
        : {
            ...upgrade,
            url: upgradeLink(
              upgrade.plan.toLowerCase() === "pro" ? "pro" : "basic",
              src
            ),
          }
    ),
  };
};
