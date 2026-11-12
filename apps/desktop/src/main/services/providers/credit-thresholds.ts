/**
 * Every plan's credit milestones (contract credit-thresholds.ts). When a
 * billed turn settles, the account is read afresh; crossing half, four
 * fifths, then 95%, of the plan's credits is stamped in the prefs row once per
 * spend-down, and a chat-app turn also hears it in the user's own chat. A
 * paid balance back above the mark (risenMilestone) lowers it, answered at
 * the level it stands at, or clears it below half; the free plan's one-time
 * grant never re-arms. Today's post-turn reads give the estimate.
 */
import {
  AgentStatus,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import {
  creditAccountKey,
  creditMilestonePlan,
  type CreditMilestonePlan,
  type CreditTaskKind,
  type CreditThreshold,
  type CreditThresholdMark,
  milestoneBalance,
  risenMilestone,
  thresholdOf,
} from "@abacus-ai/contract/credit-thresholds";

/** What a settled turn was, for the estimate's wording; null counts toward neither. */
export type SettledTurnKind = "build" | "message" | null;

interface DaySample {
  day: string;
  account: string;
  firstUsed: number;
  lastUsed: number;
  reads: number;
  kinds: Set<"build" | "message">;
}

/** A crossing to stamp, or null when this read crossed nothing new. */
export const markAfterRead = (
  previous: CreditThresholdMark | undefined,
  read: { used: number; granted: number; at: number },
  estimate: { perTask: number; kind: CreditTaskKind } | null,
  plan: CreditMilestonePlan = "free"
): CreditThresholdMark | null => {
  const reached = thresholdOf(read.used, read.granted);
  if (reached == null || (previous != null && previous.reached >= reached))
    return null;
  return {
    reached,
    at: read.at,
    used: read.used,
    granted: read.granted,
    perTask: estimate?.perTask ?? null,
    kind: estimate?.kind ?? null,
    told: previous?.told ?? null,
    plan,
  };
};

export interface CreditThresholdDeps {
  prefs: () => { get(): PrefsRow; update(patch: PrefsPatch): unknown } | null;
  /** The account read now, past every cache; null when it cannot be. */
  readAccount: () => Promise<AbacusAccountInfo | null>;
  /** Says the crossing in the user's own chat app if `sessionId` just ran a chat-app turn; whether it went. */
  tellInChat: (
    sessionId: string,
    mark: CreditThresholdMark
  ) => Promise<boolean>;
  /**
   * A chat with no card, where the line is the only telling (AbacusAI Bot's
   * WhatsApp number): a line that did not go is said again after its next
   * settled turn, until it goes.
   */
  retriesUntold?: (sessionId: string) => boolean;
  now?: () => number;
}

export class CreditThresholdWatch {
  private sample: DaySample | null = null;
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly deps: CreditThresholdDeps) {}

  /** A billed turn settled; resolves once its read is handled. Never throws. */
  turnSettled(sessionId: string, kind: SettledTurnKind): Promise<void> {
    this.queue = this.queue
      .then(() => this.check(sessionId, kind))
      .catch((error: unknown) => {
        console.warn(`[credits] threshold check failed: ${String(error)}`);
      });
    return this.queue;
  }

  private async check(sessionId: string, kind: SettledTurnKind) {
    const account = await this.deps.readAccount();
    // An unread, anonymous or team plan is not guessed at.
    const plan = creditMilestonePlan(account);
    if (account == null || plan == null) return;
    const key = creditAccountKey(account);
    const balance = milestoneBalance(account);
    if (key == null || balance == null || account.credits_used == null) return;
    const { used, granted } = balance;
    const at = this.deps.now?.() ?? Date.now();
    // Today's rate reads the account's own counter: a top-up moves no spend.
    const estimate = this.estimate(key, account.credits_used, kind, at);
    const prefs = this.deps.prefs();
    if (prefs == null) return;
    let marks = prefs.get().creditThresholds ?? {};
    const risen =
      plan === "paid" ? risenMilestone(marks[key], balance) : undefined;
    if (risen !== undefined)
      marks = this.lower(prefs, key, risen, balance, plan);
    const crossed = markAfterRead(
      marks[key],
      { used, granted, at },
      estimate,
      plan
    );
    const previous = marks[key];
    // Nothing newly crossed: an untold line goes again where only the line tells it.
    const untold =
      crossed == null &&
      previous != null &&
      (previous.told ?? 0) < previous.reached &&
      this.deps.retriesUntold?.(sessionId) === true
        ? { ...previous, used, granted, at }
        : null;
    const mark = crossed ?? untold;
    if (mark == null) return;
    if (crossed != null) {
      console.log(`[credits] threshold ${crossed.reached} reached`);
      prefs.update({ creditThresholds: { ...marks, [key]: crossed } });
    }
    if (!(await this.deps.tellInChat(sessionId, mark))) return;
    const latest = prefs.get().creditThresholds ?? {};
    prefs.update({
      creditThresholds: {
        ...latest,
        [key]: { ...(latest[key] ?? mark), told: mark.reached },
      },
    });
  }

  /**
   * A paid balance back above its mark: the mark and its card's answer move
   * down to `level` (nothing re-shows), or go once less than half is used.
   */
  private lower(
    prefs: { get(): PrefsRow; update(patch: PrefsPatch): unknown },
    key: string,
    level: CreditThreshold | null,
    balance: { used: number; granted: number },
    plan: CreditMilestonePlan
  ): Record<string, CreditThresholdMark> {
    const { [key]: mark, ...otherMarks } = prefs.get().creditThresholds ?? {};
    const { [key]: _card, ...otherCards } =
      prefs.get().dismissals.creditThresholdCards ?? {};
    console.log(`[credits] threshold ${mark?.reached} lowered to ${level}`);
    const marks =
      level == null || mark == null
        ? otherMarks
        : {
            ...otherMarks,
            [key]: {
              ...mark,
              ...balance,
              reached: level,
              plan,
              told: mark.told != null && mark.told > level ? level : mark.told,
            },
          };
    prefs.update({
      creditThresholds: marks,
      dismissals: {
        creditThresholdCards:
          level == null
            ? otherCards
            : { ...otherCards, [key]: { shown: level, answered: level } },
      },
    });
    return marks;
  }

  /**
   * Credits per completed turn today: the spend between today's first and
   * latest post-turn reads over the turns between them. Null until two reads.
   */
  private estimate(
    account: string,
    used: number,
    kind: SettledTurnKind,
    at: number
  ): { perTask: number; kind: CreditTaskKind } | null {
    const day = new Date(at).toDateString();
    const sample = this.sample;
    if (
      sample == null ||
      sample.day !== day ||
      sample.account !== account ||
      used < sample.lastUsed
    ) {
      this.sample = {
        day,
        account,
        firstUsed: used,
        lastUsed: used,
        reads: 1,
        kinds: new Set(kind != null ? [kind] : []),
      };
      return null;
    }
    sample.lastUsed = used;
    sample.reads += 1;
    if (kind != null) sample.kinds.add(kind);
    const perTask = (sample.lastUsed - sample.firstUsed) / (sample.reads - 1);
    if (!(perTask > 0)) return null;
    const only = sample.kinds.size === 1 ? [...sample.kinds][0] : null;
    return {
      perTask,
      kind:
        only === "build" ? "builds" : only === "message" ? "messages" : "tasks",
    };
  }
}

/**
 * The agent-event listener that feeds the watch: a session that ran a billed
 * turn settles it when it goes idle, never at a `turn_complete`, which the
 * agent sends after every round of tool calls.
 */
export const settledTurnListener = (
  watch: Pick<CreditThresholdWatch, "turnSettled">,
  facts: { kindOf(sessionId: string): SettledTurnKind }
): ((sessionId: string, payload: DesktopEvent) => void) => {
  const billed = new Set<string>();
  return (sessionId, payload) => {
    if (payload.type !== "event") return;
    const event = payload.event;
    if (event.type === "turn_complete") {
      // The free lane the user chose at the wall spends no credits.
      if (event.usage != null && event.usage.lane !== "free")
        billed.add(sessionId);
      return;
    }
    if (event.type !== "status_changed" || event.status !== AgentStatus.Idle)
      return;
    if (!billed.delete(sessionId)) return;
    void watch.turnSettled(sessionId, facts.kindOf(sessionId));
  };
};
