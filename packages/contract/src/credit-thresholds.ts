/**
 * The credit milestones of every plan: a card once half, then four fifths,
 * then nineteen twentieths (the last before the wall), of the plan's credits
 * are used. The free plan measures its one-time grant;
 * a paid plan its monthly credits, never what was bought on top. Main stamps
 * a crossing after a turn settles; the renderer shows the card and keeps the
 * answer. A balance back above a mark (a new month, a top-up, a new plan)
 * clears it, so the next spend-down warns again. At the whole grant the
 * out-of-credits card takes over.
 */
import {
  type BillingPlan,
  type PaidCreditsOffer,
  paidCreditsOffer,
  type PlanT,
} from "./billing-plan";
import type { AbacusAccountInfo } from "./contracts";
import { abacusAccountTier, isPayingAbacusTier } from "./models";

export const CREDIT_THRESHOLDS = [50, 80, 95] as const;
export type CreditThreshold = (typeof CREDIT_THRESHOLDS)[number];

/** What today's turns were: builds in Sessions, bot messages, or a mix. */
export const CREDIT_TASK_KINDS = ["builds", "messages", "tasks"] as const;
export type CreditTaskKind = (typeof CREDIT_TASK_KINDS)[number];

/** One account's latest crossing, as main stamped it. */
export interface CreditThresholdMark {
  reached: CreditThreshold;
  at: number;
  /** The account read right after the turn that crossed it. */
  used: number;
  granted: number;
  /** Credits per completed turn today, measured from post-turn reads; null when unknown. */
  perTask: number | null;
  kind: CreditTaskKind | null;
  /** The highest threshold already told in the user's own chat app. */
  told: CreditThreshold | null;
  /**
   * The plan the watch read when it stamped the mark; every surface speaks in
   * its words. Absent from marks stamped before paid plans had milestones,
   * which only the free plan had.
   */
  plan?: CreditMilestonePlan;
}

/** The plan a mark speaks for (see `plan`). */
export const markPlan = (
  mark: Pick<CreditThresholdMark, "plan">
): CreditMilestonePlan => mark.plan ?? "free";

/** The card's state for one account, written by the renderer. */
export interface CreditThresholdCard {
  shown: CreditThreshold | null;
  answered: CreditThreshold | null;
}

/** The prefs key for an account; null without a stable id, so nothing is shown. */
export const creditAccountKey = (
  account:
    | Pick<AbacusAccountInfo, "user_id" | "organization_id">
    | null
    | undefined
): string | null =>
  account?.user_id != null && account.user_id !== ""
    ? `${account.organization_id ?? ""}:${account.user_id}`
    : null;

/**
 * Whose words the milestones speak in. Paid means a plan the user buys for
 * themselves (PAYING_ABACUS_TIERS), with a top-up or a next plan to offer;
 * a team, enterprise or unread plan gets none, and is not guessed at.
 */
export type CreditMilestonePlan = "free" | "paid";

export const creditMilestonePlan = (
  account: AbacusAccountInfo | null | undefined
): CreditMilestonePlan | null => {
  const tier = abacusAccountTier(account);
  return tier === "free" ? "free" : isPayingAbacusTier(tier) ? "paid" : null;
};

/**
 * The notice the agent's low-credit steer shows a paid user, by its action
 * id. The agent cannot import this package and names it again as
 * CREDITS_LOW_ACTION in packages/agent/src/session.ts: the two must match.
 */
export const CREDITS_LOW_NOTICE_ACTION = "credits-low";

/**
 * What the milestones measure: the credits used against the plan's own
 * (`plan_credits`, or the grant when the server names none, as on the free
 * plan). Bought credits on top lift what is left without lifting the plan,
 * so someone who topped up is not low until they spend back below it.
 * A promoted first month grants less than the plan: the smaller of the two.
 * The same base as the agent's low-credit steer (lowCreditBase in
 * packages/agent/src/credit-balance.ts), which this package cannot import.
 */
export const milestoneBalance = (
  account:
    | Pick<
        AbacusAccountInfo,
        "credits_used" | "credits_granted" | "plan_credits"
      >
    | null
    | undefined
): { used: number; granted: number } | null => {
  const used = account?.credits_used;
  const granted = account?.credits_granted;
  if (used == null || granted == null || !(granted > 0)) return null;
  const plan = account?.plan_credits;
  const base = plan != null && plan > 0 ? Math.min(plan, granted) : granted;
  const left = Math.max(0, granted - used);
  return { used: Math.max(0, base - left), granted: base };
};

/** The highest threshold `used` has crossed, below the whole grant. */
export const thresholdOf = (
  used: number,
  granted: number
): CreditThreshold | null => {
  if (!(granted > 0) || used >= granted) return null;
  const share = used / granted;
  return share >= 0.95 ? 95 : share >= 0.8 ? 80 : share >= 0.5 ? 50 : null;
};

/**
 * A paid plan's balance back above its mark (a new month, a top-up or a new
 * plan): the level it stands at now, null once less than half is used, or
 * undefined when it has not risen. The watch lowers the mark to that level,
 * answered there, so a partial top-up brings back no card it already showed,
 * and spending down again warns at the next level; below half it clears.
 */
export const risenMilestone = (
  mark: Pick<CreditThresholdMark, "reached"> | undefined,
  read: { used: number; granted: number }
): CreditThreshold | null | undefined => {
  if (mark == null || read.used >= read.granted) return undefined;
  const level = thresholdOf(read.used, read.granted);
  return (level ?? 0) < mark.reached ? level : undefined;
};

/**
 * Whether a mark still describes the account as it reads now: the same plan
 * and a balance still at or past the mark's level. A mark from before an
 * upgrade, a new month or a top-up speaks of credits that are gone; until the
 * watch's next read replaces it, nothing may show it. The account query can
 * trail the read that stamped the mark, so the mark's own count stands in
 * while both measure the same grant.
 */
export const markHolds = (
  mark: CreditThresholdMark | undefined,
  account: AbacusAccountInfo | null | undefined
): mark is CreditThresholdMark => {
  const plan = creditMilestonePlan(account);
  const balance = milestoneBalance(account);
  if (mark == null || plan == null || balance == null) return false;
  if (markPlan(mark) !== plan) return false;
  const used =
    mark.granted === balance.granted
      ? Math.max(balance.used, mark.used)
      : balance.used;
  const level = thresholdOf(used, balance.granted);
  return level != null && level >= mark.reached;
};

/** The threshold whose card is still owed: one past the last answer, while the mark holds. */
export const pendingThreshold = (
  mark: CreditThresholdMark | undefined,
  card: CreditThresholdCard | undefined,
  account: AbacusAccountInfo | null | undefined
): CreditThreshold | null =>
  markHolds(mark, account) && (card?.answered ?? 0) < mark.reached
    ? mark.reached
    : null;

/** Whole tasks at today's rate that `left` still pays for; null below one. */
export const tasksLeft = (
  left: number,
  perTask: number | null
): number | null => {
  if (perTask == null || !(perTask > 0)) return null;
  const count = Math.floor(left / perTask);
  return count >= 1 ? count : null;
};

/** The copy both the card and the chat-app line read (locale keys). */
export const CREDIT_THRESHOLD_COPY = {
  50: {
    title: "creditThreshold.half.title",
    body: "creditThreshold.half.body",
    paidTitle: "creditThreshold.half.paidTitle",
    paidBody: "creditThreshold.half.paidBody",
    estimate: {
      builds: "creditThreshold.half.estimateBuilds",
      messages: "creditThreshold.half.estimateMessages",
      tasks: "creditThreshold.half.estimateTasks",
    },
  },
  80: {
    title: "creditThreshold.low.title",
    body: "creditThreshold.low.urge",
    bodyProject: "creditThreshold.low.urgeProject",
    bodyProjectModel: "creditThreshold.low.urgeProjectModel",
    paidTitle: "creditThreshold.low.paidTitle",
    estimate: {
      builds: "creditThreshold.low.estimateBuilds",
      messages: "creditThreshold.low.estimateMessages",
      tasks: "creditThreshold.low.estimateTasks",
    },
  },
  // The last before the wall: the near-the-end estimate and paid ways on are
  // the 80% card's; the title and the free plan's urge are its own.
  95: {
    title: "creditThreshold.last.title",
    body: "creditThreshold.last.urge",
    bodyProject: "creditThreshold.last.urgeProject",
    bodyProjectModel: "creditThreshold.last.urgeProjectModel",
    paidTitle: "creditThreshold.last.paidTitle",
    estimate: {
      builds: "creditThreshold.low.estimateBuilds",
      messages: "creditThreshold.low.estimateMessages",
      tasks: "creditThreshold.low.estimateTasks",
    },
  },
} as const satisfies Record<
  CreditThreshold,
  {
    title: string;
    body: string;
    /** The body naming the project the user is on. */
    bodyProject?: string;
    /** The free plan's, naming the project and the top model the upgrade unlocks. */
    bodyProjectModel?: string;
    /** A paid plan's: its credits are this month's, and there is no "free". */
    paidTitle: string;
    paidBody?: string;
    estimate: Record<CreditTaskKind, string>;
  }
>;

/**
 * A paid plan's way on near the end of its credits, by the one offer rule
 * (paidCreditsOffer): top up and the next plan, the next plan alone (Basic),
 * or more credits where neither link is known (or the plan is bought in the
 * mobile app). Each with the project the user is on, when it is known.
 */
const PAID_URGE = {
  both: {
    plain: "creditThreshold.low.paidUrgeBoth",
    project: "creditThreshold.low.paidUrgeBothProject",
  },
  next: {
    plain: "creditThreshold.low.paidUrgeNext",
    project: "creditThreshold.low.paidUrgeNextProject",
  },
  more: {
    plain: "creditThreshold.low.paidUrgeMore",
    project: "creditThreshold.low.paidUrgeMoreProject",
  },
} as const;

/** What a milestone offers: the free plan's upgrade, or a paid plan's offer (null: none known). */
export type MilestoneOffer =
  | { plan: "free" }
  | { plan: "paid"; offer: PaidCreditsOffer | null };

export const milestoneOffer = (
  plan: CreditMilestonePlan,
  billing: BillingPlan | null | undefined
): MilestoneOffer =>
  plan === "free"
    ? { plan: "free" }
    : { plan: "paid", offer: paidCreditsOffer(billing) };

const paidUrge = (
  t: PlanT,
  offer: PaidCreditsOffer | null,
  project: string | undefined
): string => {
  const next = offer?.inMobileApp === true ? null : offer?.next;
  const keys =
    next != null && offer?.topUpUrl != null
      ? PAID_URGE.both
      : next != null
        ? PAID_URGE.next
        : PAID_URGE.more;
  const values = {
    ...(next != null && { plan: next.planName }),
    ...(project != null && { project }),
  };
  return t(project != null ? keys.project : keys.plain, values);
};

/**
 * The card's title and sentences, which the chat-app line repeats: what is
 * left of the grant, then the estimate at today's rate when there is one;
 * near the end, the project the user is on when it is known, and on the free
 * plan the top model the upgrade would finish it on (`topModel`, by name).
 */
export function creditThresholdWords(
  t: PlanT,
  locale: string,
  threshold: CreditThreshold,
  balance: { left: number; total: number },
  estimate: { count: number; kind: CreditTaskKind | null } | null,
  project?: string,
  offer: MilestoneOffer = { plan: "free" },
  topModel?: string
): { title: string; lines: string[] } {
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(value)));
  const copy = CREDIT_THRESHOLD_COPY[threshold];
  const guess =
    estimate != null
      ? t(copy.estimate[estimate.kind ?? "tasks"], { count: estimate.count })
      : null;
  const paid = offer.plan === "paid";
  if (threshold === 50)
    return {
      title: t(paid ? copy.paidTitle : copy.title),
      lines: [
        t(paid ? CREDIT_THRESHOLD_COPY[50].paidBody : copy.body, {
          left: number(balance.left),
          total: number(balance.total),
        }),
        ...(guess != null ? [guess] : []),
      ],
    };
  const near = CREDIT_THRESHOLD_COPY[threshold];
  return {
    title: t(paid ? near.paidTitle : near.title, {
      left: number(balance.left),
    }),
    lines: [
      ...(guess != null ? [guess] : []),
      offer.plan === "paid"
        ? paidUrge(t, offer.offer, project)
        : project != null
          ? topModel != null
            ? t(near.bodyProjectModel, { project, model: topModel })
            : t(near.bodyProject, { project })
          : t(near.body),
    ],
  };
}

/**
 * The account codes: the platform reads Sessions as where it mostly works,
 * or the mark that still holds says today's turns were builds. Its next-plan
 * pitch leads with the coding router.
 */
export const accountCodes = (
  account: AbacusAccountInfo | null | undefined,
  mark: CreditThresholdMark | undefined
): boolean =>
  account?.focus === "sessions" ||
  (markHolds(mark, account) && mark.kind === "builds");
