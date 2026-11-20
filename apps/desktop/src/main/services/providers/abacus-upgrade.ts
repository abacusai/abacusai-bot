import type { BillingPlan, UpgradeSrc } from "@abacus-ai/contract/billing-plan";
import type { OnboardingOfferAccountStep } from "@abacus-ai/contract/funnel";

import {
  isBotUpgradeLink,
  withUpgradeReturn,
  withUpgradeSignIn,
} from "../../external-links";
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
export const botUpgradePage = (src: UpgradeSrc): string => {
  const url = new URL("/bot/link/upgrade", abacusAppHost());
  url.searchParams.set("src", src);
  return url.toString();
};

/** Opening the link waits at most this long for the code, then opens without it. */
const UPGRADE_SIGNIN_CODE_TIMEOUT_MS = 3000;

/**
 * A one-time code that signs the browser in to this account on the upgrade
 * page, for a bot-only free account (the platform answers null for any
 * other, or when the call fails, and the page signs in as before). Asked for
 * each time a link is opened, never cached: it lives two minutes.
 */
export const fetchUpgradeSignInCode = async (): Promise<string | null> => {
  const { ok, result } = await abacusApiCall(
    "_createAbacusbotWebSigninCode",
    "POST",
    undefined,
    UPGRADE_SIGNIN_CODE_TIMEOUT_MS
  );
  if (!ok || result == null || typeof result !== "object") return null;
  const code = (result as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
};

/**
 * What the app hands the OS for an external link: the bot's upgrade page
 * comes back to the app once paid (withUpgradeReturn) and signs a
 * signed-out browser in with a fresh code; anything else is unchanged.
 */
export const externalLinkTarget = async (url: string): Promise<string> => {
  const target = withUpgradeReturn(url, abacusAppHost());
  if (!isBotUpgradeLink(target, abacusAppHost())) return target;
  return withUpgradeSignIn(target, await fetchUpgradeSignInCode());
};

/** The surface AbacusAI Bot's WhatsApp number tags its upgrade links with. */
export const WHATSAPP_UPGRADE_SRC = "whatsapp";

/** Well inside the link's life, so a cached link is never a dead one. */
const UPGRADE_URL_TTL_MS = 60_000;

let cached: {
  key: string;
  src: UpgradeSrc;
  url: string | null;
  at: number;
} | null = null;

export const fetchUpgradeUrl = async (
  /** The screen the link is opened from; the platform counts upgrades by it. */
  src: UpgradeSrc = "app",
  /** A held sign-in's key, in place of the stored one. */
  heldKey?: string
): Promise<string | null> => {
  const key = heldKey ?? credentialFor("ABACUS_API_KEY");
  if (key.length === 0) return null;
  if (
    cached != null &&
    cached.key === key &&
    cached.src === src &&
    Date.now() - cached.at < UPGRADE_URL_TTL_MS
  )
    return cached.url;
  const { ok, result } = await abacusApiCall(
    "_createAbacusbotUpgradeLink",
    "GET",
    { src },
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
  cached = { key, src, url: link, at: Date.now() };
  return link;
};

/**
 * The signed-in account's plan, credits and upgrade paths: with `upgrade`, a
 * free account's upgrades carry its own one-time Basic and Pro links (minted
 * only then). Null when signed out, when the platform offers none, or when
 * the call fails.
 */
/**
 * The server's coin tosses this build can show, sent with every plan read
 * (`experiments`): a toss runs, and counts an account, only for a build that
 * lists it.
 */
const APP_EXPERIMENTS = ["opus_retry"];

export const fetchBillingPlan = async (
  upgrade: boolean,
  /** A held sign-in's key, in place of the stored one. */
  heldKey?: string,
  /** The surface the upgrade links are for ("whatsapp"); the server's default otherwise. */
  src?: string
): Promise<BillingPlan | null> => {
  const query = {
    experiments: APP_EXPERIMENTS.join(","),
    ...(upgrade ? { includeUpgradeLinks: true } : {}),
    ...(src != null ? { src } : {}),
  };
  const { ok, result } = await abacusApiCall(
    "_getAbacusbotBillingPlan",
    "GET",
    query,
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
