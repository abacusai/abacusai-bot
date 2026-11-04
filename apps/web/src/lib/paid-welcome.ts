import type { PrefsRow } from "@abacus-ai/contract/contract/rows";
/**
 * The welcome after a payment lands: when it is owed (once per upgrade, kept
 * in prefs dismissals), and the hand-off that lets it send a turn the upgrade
 * paused instead of the upgrade dialog sending it unseen.
 */
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import { accountTier, creditsTier } from "./credits";

/** A turn the upgrade stopped, and the upgrade dialog's way of sending it again. */
export interface PausedTurn {
  /** The person's waiting message, when the chat has one. */
  text?: string;
  resume: () => Promise<unknown>;
}

type WelcomeMarks = Pick<
  PrefsRow["dismissals"],
  "freePlanSeenAt" | "upgradeRoutinesSeenAt" | "paidWelcomeTier"
>;

/** Higher is more plan; a paying tier the app has no rank for counts as the first. */
const TIER_RANK: Record<string, number> = { go: 1, basic: 1, pro: 2, max: 3 };

const rank = (tier: string | null | undefined): number =>
  tier == null ? 0 : (TIER_RANK[tier] ?? 1);

export interface WelcomeDecision {
  show: boolean;
  /** The dismissals to write now, if any. */
  write?: Partial<WelcomeMarks>;
}

/**
 * What one account read means for the welcome. `from` is the account before
 * a payment this app watched land; without it, an upgrade is a paid read
 * after a free one. A free read forgets the last welcome, so the next upgrade
 * is told again; a lower paid tier records itself, so moving back up is too;
 * a payer this app never saw free records its tier without a welcome.
 */
export const paidWelcomeDecision = (
  marks: WelcomeMarks,
  account: AbacusAccountInfo | null | undefined,
  from?: AbacusAccountInfo | null
): WelcomeDecision => {
  const plan = creditsTier(account);
  if (plan === "unknown") return { show: false };
  if (plan === "free")
    return marks.paidWelcomeTier != null || marks.upgradeRoutinesSeenAt != null
      ? {
          show: false,
          write: { paidWelcomeTier: null, upgradeRoutinesSeenAt: null },
        }
      : { show: false };
  const tier = accountTier(account) ?? null;
  const now = rank(tier);
  const welcomed = rank(marks.paidWelcomeTier);
  const before =
    from == null
      ? null
      : creditsTier(from) === "free"
        ? 0
        : rank(accountTier(from));
  if (before != null && now > before && now >= welcomed)
    return { show: true, write: { paidWelcomeTier: tier } };
  if (marks.paidWelcomeTier == null)
    // An older build's after-upgrade card told this upgrade, or no free read came first.
    return marks.upgradeRoutinesSeenAt != null || marks.freePlanSeenAt == null
      ? { show: false, write: { paidWelcomeTier: tier } }
      : { show: true, write: { paidWelcomeTier: tier } };
  if (now > welcomed) return { show: true, write: { paidWelcomeTier: tier } };
  if (now < welcomed) return { show: false, write: { paidWelcomeTier: tier } };
  return { show: false };
};

/** Where the upgrade dialog's landing came from: the chat it opened in, and its paused turn. */
export interface LandedFrom {
  threadId: string;
  paused: PausedTurn | null;
}

/** The mounted welcome: the landed account, the one before it and the dialog's chat; true when it shows. */
type WelcomeHost = (
  account: AbacusAccountInfo,
  from: AbacusAccountInfo | null,
  landed: LandedFrom
) => boolean;

let host: WelcomeHost | null = null;

export const registerPaidWelcome = (offer: WelcomeHost): (() => void) => {
  host = offer;
  return () => {
    if (host === offer) host = null;
  };
};

/**
 * The upgrade dialog's plan landed: the welcome shows with the paused turn
 * as its first step, or, when no welcome is owed (a top-up, no host
 * mounted), the turn is sent now as before.
 */
export const welcomeLandedPlan = (
  account: AbacusAccountInfo,
  from: AbacusAccountInfo | null,
  landed: LandedFrom
): void => {
  if (host?.(account, from, landed) === true) return;
  void landed.paused?.resume().catch(() => {});
};
