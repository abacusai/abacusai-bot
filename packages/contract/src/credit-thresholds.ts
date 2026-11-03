/**
 * The free plan's credit milestones: a card once half, then four fifths, of
 * the free grant is used, each once per account. Main stamps a crossing after
 * a turn settles; the renderer shows the card and keeps the answer. At the
 * whole grant the out-of-credits card takes over.
 */
import type { PlanT } from "./billing-plan";
import type { AbacusAccountInfo } from "./contracts";

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
}

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

/** The highest threshold `used` has crossed, below the whole grant. */
export const thresholdOf = (
  used: number,
  granted: number
): CreditThreshold | null => {
  if (!(granted > 0) || used >= granted) return null;
  const share = used / granted;
  return share >= 0.8 ? 80 : share >= 0.5 ? 50 : null;
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
    estimate: Record<CreditTaskKind, string>;
  }
>;

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
  project?: string
): { title: string; lines: string[] } {
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(value)));
  const copy = CREDIT_THRESHOLD_COPY[threshold];
  const guess =
    estimate != null
      ? t(copy.estimate[estimate.kind ?? "tasks"], { count: estimate.count })
      : null;
  if (threshold === 50)
    return {
      title: t(copy.title),
      lines: [
        t(copy.body, {
          left: number(balance.left),
          total: number(balance.total),
        }),
        ...(guess != null ? [guess] : []),
      ],
    };
  return {
    title: t(copy.title, { left: number(balance.left) }),
    lines: [
      ...(guess != null ? [guess] : []),
      project != null
        ? t(CREDIT_THRESHOLD_COPY[80].bodyProject, { project })
        : t(copy.body),
    ],
  };
}
