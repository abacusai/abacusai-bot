import { paidCreditsOffer } from "@abacus-ai/contract/billing-plan";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";

import {
  ABACUS_BILLING_URL,
  ABACUS_BUY_CREDITS_URL,
  ABACUS_PLAN_URL,
} from "./abacus-links";
import { creditsTier } from "./credits";
import { openPendingLink } from "./platform-system";

/** How often the account is read again while checkout is open. */
const PLAN_POLL_MS = 5_000;
/** The one-time checkout link lives 30 minutes; the watch stops after it. */
const PLAN_POLL_LIMIT_MS = 30 * 60 * 1000;

export const payingAccount = (
  account: AbacusAccountInfo | null | undefined
): boolean => {
  const tier = creditsTier(account);
  return tier === "basic" || tier === "paid";
};

type PlanListener = (account: AbacusAccountInfo) => void;

const planListeners = new Set<PlanListener>();

/** Hears the account turn paid, whichever surface sent it to checkout. */
export const onPlanActive = (listener: PlanListener): (() => void) => {
  planListeners.add(listener);
  return () => {
    planListeners.delete(listener);
  };
};

let watch: {
  done: Promise<AbacusAccountInfo | null>;
  checkNow: () => void;
} | null = null;

/** Credits the account has left, by its counters; null when it does not say. */
const creditsLeft = (account: AbacusAccountInfo | null): number | null =>
  account?.credits_granted != null && account.credits_used != null
    ? account.credits_granted - account.credits_used
    : null;

/**
 * Reads the account until `settled` says the payment landed: every few
 * seconds and at once when the window comes back, for as long as the
 * checkout link lives. One watch at a time, however many surfaces start it.
 * Then the catalog is read afresh, every listener hears it, and the promise
 * has the account; null when the link ran out first.
 */
const watchAccount = (
  client: AppClient,
  settled: (fresh: AbacusAccountInfo | null) => Promise<boolean>,
  landed?: () => Promise<unknown>
): Promise<AbacusAccountInfo | null> => {
  if (watch != null) return watch.done;
  let settle: (account: AbacusAccountInfo | null) => void = () => {};
  const done = new Promise<AbacusAccountInfo | null>((resolve) => {
    settle = resolve;
  });
  const started = Date.now();
  let checking = false;
  let timer: ReturnType<typeof setInterval> | null = null;
  const finish = (account: AbacusAccountInfo | null) => {
    if (timer != null) clearInterval(timer);
    window.removeEventListener("focus", check);
    watch = null;
    settle(account);
  };
  async function check() {
    if (checking || watch?.done !== done) return;
    checking = true;
    const fresh = await client.account
      .abacus({ refresh: true })
      .catch(() => null);
    const paid = await settled(fresh);
    checking = false;
    if (watch?.done !== done) return;
    if (paid) {
      await landed?.().catch(() => null);
      // The plan's catalog, not the one read before checkout.
      await client.models.list({ refresh: true }).catch(() => null);
      for (const listener of Array.from(planListeners)) listener(fresh!);
      finish(fresh);
      return;
    }
    if (Date.now() - started > PLAN_POLL_LIMIT_MS) finish(null);
  }
  watch = { done, checkNow: () => void check() };
  timer = setInterval(() => void check(), PLAN_POLL_MS);
  window.addEventListener("focus", check);
  return done;
};

/** Reads the account until it is on a paid plan (see watchAccount). */
export const watchForPlan = (
  client: AppClient
): Promise<AbacusAccountInfo | null> =>
  watchAccount(client, async (fresh) => payingAccount(fresh));

/**
 * A paid account out of credits: reads the account until it has more credits
 * than when the watch began, or is on another plan (see watchAccount). Then
 * the credit wall comes down at once, so no agent waits out the account's
 * cached balance before using the new credits.
 */
export const watchForCredits = (
  client: AppClient
): Promise<AbacusAccountInfo | null> => {
  if (watch != null) return watch.done;
  const before = client.account.abacus().catch(() => null);
  return watchAccount(
    client,
    async (fresh) => {
      const base = await before;
      if (fresh == null) return false;
      if (base != null && creditsTier(fresh) !== creditsTier(base)) return true;
      const left = creditsLeft(fresh);
      const was = creditsLeft(base);
      return left != null && left > Math.max(0, was ?? 0);
    },
    () =>
      client.db.prefs.update({
        patch: { creditsExhaustedAt: null, freeLaneChosenAt: null },
      })
  );
};

/** Reads the account now, for a person who says they have paid. */
export const checkPlanNow = (): void => watch?.checkNow();

/**
 * Upgrade: the account's own upgrade page, asked for at click time (its link
 * is one-time and short-lived), or the plan page when the account has none.
 * The account is then watched until the plan is active, so the app changes
 * the moment the payment lands.
 */
export const openUpgrade = async (client: AppClient): Promise<void> => {
  await openPendingLink(
    client,
    async () =>
      (await client.account.upgradeUrl({}).catch(() => null)) ?? ABACUS_PLAN_URL
  );
  void watchForPlan(client);
};

/**
 * A paid account's top-up: the server's buy-credits link, read at click time
 * (the account's page when it cannot be read), then the account is watched
 * until the credits land.
 */
export const openTopUp = async (client: AppClient): Promise<void> => {
  await openPendingLink(
    client,
    async () =>
      paidCreditsOffer(await client.account.billingPlan({}).catch(() => null))
        ?.topUpUrl ?? ABACUS_BUY_CREDITS_URL
  );
  void watchForCredits(client);
};

/**
 * A paid account's next plan up: its page as the server names it, read at
 * click time (the account's billing page when it cannot be read), then the
 * account is watched until the plan or its credits change.
 */
export const openNextPlan = async (client: AppClient): Promise<void> => {
  await openPendingLink(
    client,
    async () =>
      paidCreditsOffer(await client.account.billingPlan({}).catch(() => null))
        ?.next?.url ?? ABACUS_BILLING_URL
  );
  void watchForCredits(client);
};
