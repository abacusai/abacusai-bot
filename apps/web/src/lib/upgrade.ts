import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import type { AppClient } from "#renderer/data/transport/types";

import { ABACUS_PLAN_URL } from "./abacus-links";
import { creditsTier } from "./credits";
import { openPendingLink } from "./platform-system";

/** How often the account is read again while checkout is open. */
const PLAN_POLL_MS = 5_000;
/** How long a checkout is watched before the app stops reading the account. */
const PLAN_WATCH_LIMIT_MS = 30 * 60 * 1000;

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

/**
 * Reads the account until it is on a paid plan: every few seconds and at once
 * when the window comes back, for half an hour. One watch at a time, however
 * many surfaces start it. On the plan: the catalog is read afresh, every
 * listener hears it, and the promise has the account; null when it gave up.
 */
export const watchForPlan = (
  client: AppClient
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
    checking = false;
    if (watch?.done !== done) return;
    if (payingAccount(fresh)) {
      // The plan's catalog, not the free one read before checkout.
      await client.models.list({ refresh: true }).catch(() => null);
      for (const listener of Array.from(planListeners)) listener(fresh!);
      finish(fresh);
      return;
    }
    if (Date.now() - started > PLAN_WATCH_LIMIT_MS) finish(null);
  }
  watch = { done, checkNow: () => void check() };
  timer = setInterval(() => void check(), PLAN_POLL_MS);
  window.addEventListener("focus", check);
  return done;
};

/** Reads the account now, for a person who says they have paid. */
export const checkPlanNow = (): void => watch?.checkNow();

/**
 * Upgrade: the permanent upgrade page (main builds it from the cached plan, no
 * network wait), or the plan page for a higher paid plan. The account is then
 * watched until the plan is active, so the app changes the moment it lands.
 */
export const openUpgrade = async (client: AppClient): Promise<void> => {
  await openPendingLink(
    client,
    async () =>
      (await client.account.upgradeUrl({}).catch(() => null)) ?? ABACUS_PLAN_URL
  );
  void watchForPlan(client);
};
