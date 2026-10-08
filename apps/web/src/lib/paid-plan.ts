import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";

import { creditsTier } from "./credits";

/** Only known paid tiers, with usable counters or an explicit unlimited flag. */
export const paidPlan = (account: AbacusAccountInfo | null | undefined) => {
  if (!account || !["paid", "basic"].includes(creditsTier(account)))
    return null;
  const unlimited = account.credits_unlimited === true;
  const total = account.credits_granted;
  const used = account.credits_used;
  if (
    !unlimited &&
    (total == null ||
      used == null ||
      !Number.isFinite(total) ||
      !Number.isFinite(used) ||
      total < 0)
  )
    return null;
  const remaining = unlimited
    ? null
    : Math.max(0, Math.max(0, total!) - Math.max(0, used!));
  const managed =
    !!account.organization_id ||
    !!account.organization ||
    account.subscription_tier?.trim().toLowerCase() === "enterprise";
  const canManage = account.can_manage_billing ?? !managed;
  const trial = account.trial_ends_at ? new Date(account.trial_ends_at) : null;
  return {
    name: account.plan?.trim() || account.subscription_tier!.trim(),
    total: unlimited ? null : total!,
    remaining,
    low: remaining != null && remaining <= Math.max(0, total!) * 0.1,
    canManage,
    trialEnd: trial && Number.isFinite(trial.getTime()) ? trial : null,
  };
};

export const formatCredits = (value: number, locale: string) =>
  new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(value);
