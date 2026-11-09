/**
 * The credit milestones of every plan: a card once half, then four fifths,
 * of the plan's credits are used. The free plan measures its one-time grant;
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

export const CREDIT_THRESHOLDS = [50, 80] as const;
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
  return share >= 0.8 ? 80 : share >= 0.5 ? 50 : null;
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

/** The threshold whose card is still owed: one past the last answer. */
export const pendingThreshold = (
  mark: CreditThresholdMark | undefined,
  card: CreditThresholdCard | undefined
): CreditThreshold | null =>
  mark != null && (card?.answered ?? 0) < mark.reached ? mark.reached : null;

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
    paidTitle: "creditThreshold.low.paidTitle",
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
 * near the end, the project the user is on when it is known.
 */
export function creditThresholdWords(
  t: PlanT,
  locale: string,
  threshold: CreditThreshold,
  balance: { left: number; total: number },
  estimate: { count: number; kind: CreditTaskKind | null } | null,
  project?: string,
  offer: MilestoneOffer = { plan: "free" }
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
  return {
    title: t(paid ? copy.paidTitle : copy.title, {
      left: number(balance.left),
    }),
    lines: [
      ...(guess != null ? [guess] : []),
      offer.plan === "paid"
        ? paidUrge(t, offer.offer, project)
        : project != null
          ? t(CREDIT_THRESHOLD_COPY[80].bodyProject, { project })
          : t(copy.body),
    ],
  };
}
