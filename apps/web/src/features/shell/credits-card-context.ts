/**
 * What the sidebar credits card says about the user's own work once half the
 * free credits are used: the level reached, the chat they are on, and how much
 * more of today's work the credits left pay for.
 */
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import {
  CREDIT_THRESHOLD_COPY,
  type CreditTaskKind,
  type CreditThresholdMark,
  creditMilestonePlan,
  markHolds,
  markPlan,
  milestoneBalance,
  tasksLeft,
  thresholdOf,
} from "@abacus-ai/contract/credit-thresholds";

/** The milestones' levels, and 100 once the grant is used up. */
export type CreditsCardLevel = 50 | 80 | 95 | 100;

export interface CreditsCardContext {
  level: CreditsCardLevel;
  /** The chat the user worked in last, by its name. */
  project?: string;
  estimate: { count: number; kind: CreditTaskKind | null } | null;
}

/** The level the free plan's credits stand at, by the milestones' measure; null under half. */
export const creditsCardLevel = (
  account: AbacusAccountInfo | null | undefined
): CreditsCardLevel | null => {
  const balance = milestoneBalance(account);
  if (balance == null) return null;
  return balance.used >= balance.granted
    ? 100
    : thresholdOf(balance.used, balance.granted);
};

/**
 * The free plan's context from half used: the estimate only from a free
 * plan's mark that still describes the account (markHolds), so no figure
 * outlives a new grant. Null for any other plan, or under half.
 */
export const creditsCardContext = (
  account: AbacusAccountInfo | null | undefined,
  mark: CreditThresholdMark | undefined,
  project: string | undefined
): CreditsCardContext | null => {
  if (creditMilestonePlan(account) !== "free") return null;
  const level = creditsCardLevel(account);
  const balance = milestoneBalance(account);
  if (level == null || balance == null) return null;
  const count =
    level !== 100 && markHolds(mark, account) && markPlan(mark) === "free"
      ? tasksLeft(balance.granted - balance.used, mark.perTask)
      : null;
  return {
    level,
    ...(project != null && project.length > 0 && { project }),
    estimate: count != null && mark != null ? { count, kind: mark.kind } : null,
  };
};

/** The milestone card's estimate sentence for the level (locale key). */
export const estimateKey = (
  level: Exclude<CreditsCardLevel, 100>,
  kind: CreditTaskKind | null
): string => CREDIT_THRESHOLD_COPY[level].estimate[kind ?? "tasks"];
