import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { OnboardingOfferAccountStep } from "@abacus-ai/contract/funnel";

import { credentialFor } from "../config/settings";
import { abacusApiCall } from "./abacus-connector-service";
import { abacusAppHost } from "./abacus-host";

/**
 * The account's own upgrade page: a one-time link the platform binds to the
 * signed-in user, live for 30 minutes (asking again while it is live returns
 * the same one). Null when the account has no upgrade offer, such as a paid
 * plan, or when signed out; the bot's own upgrade page when the call fails.
 */

/**
 * The bot's own upgrade page on the app host: it signs the user in and makes
 * their checkout itself. What every surface falls back to when no one-time
 * link could be minted (offline, a slow proxy), never the chat product's
 * plans page.
 */
export const botUpgradePage = (src: "app" | "channel" | "whatsapp"): string => {
  const url = new URL("/bot/link/upgrade", abacusAppHost());
  url.searchParams.set("src", src);
  return url.toString();
};

/** The surface AbacusAI Bot's WhatsApp number tags its upgrade links with. */
export const WHATSAPP_UPGRADE_SRC = "whatsapp";

/** Well inside the link's life, so a cached link is never a dead one. */
const UPGRADE_URL_TTL_MS = 60_000;

let cached: { key: string; url: string | null; at: number } | null = null;

export const fetchUpgradeUrl = async (
  src: "app" | "channel" = "app",
  /** A held sign-in's key, in place of the stored one. */
  heldKey?: string
): Promise<string | null> => {
  const key = heldKey ?? credentialFor("ABACUS_API_KEY");
  if (key.length === 0) return null;
  if (
    cached != null &&
    cached.key === key &&
    Date.now() - cached.at < UPGRADE_URL_TTL_MS
  )
    return cached.url;
  const { ok, result } = await abacusApiCall(
    "_createAbacusbotUpgradeLink",
    "GET",
    undefined,
    undefined,
    heldKey
  );
  // Offline or refused: the bot's own page, never no link at all. Not
  // cached, so the next ask mints again once the network is back.
  if (!ok) return botUpgradePage(src);
  const url =
    result != null && typeof result === "object"
      ? (result as Record<string, unknown>).url
      : null;
  const link =
    typeof url === "string" && url.startsWith("https://") ? url : null;
  cached = { key, url: link, at: Date.now() };
  return link;
};

/**
 * The signed-in account's plan, credits and upgrade paths: with `upgrade`, a
 * free account's upgrades carry its own one-time Basic and Pro links (minted
 * only then). Null when signed out, when the platform offers none, or when
 * the call fails.
 */
export const fetchBillingPlan = async (
  upgrade: boolean,
  /** A held sign-in's key, in place of the stored one. */
  heldKey?: string,
  /** The surface the upgrade links are for ("whatsapp"); the server's default otherwise. */
  src?: string
): Promise<BillingPlan | null> => {
  const query = {
    ...(upgrade ? { includeUpgradeLinks: true } : {}),
    ...(src != null ? { src } : {}),
  };
  const { ok, result } = await abacusApiCall(
    "_getAbacusbotBillingPlan",
    "GET",
    Object.keys(query).length > 0 ? query : undefined,
    undefined,
    heldKey
  );
  if (!ok || result == null || typeof result !== "object") return null;
  return result as BillingPlan;
};

/**
 * Records a step of the onboarding offer on the signed-in account, which the
 * platform counts. Fire and forget: onboarding never waits
 * on it, and a lost step is not retried.
 */
export const reportOnboardingOffer = (
  step: OnboardingOfferAccountStep
): void => {
  void abacusApiCall(
    "_logAbacusbotOnboardingOffer",
    "POST",
    { step },
    10_000
  ).catch(() => {});
};
