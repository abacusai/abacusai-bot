/**
 * The free plan's credit milestones (contract credit-thresholds.ts). When a
 * billed turn settles, the account is read afresh; crossing half, then four
 * fifths, of the free grant is stamped in the prefs row once per account, and
 * a chat-app turn also hears it in the user's own chat. Today's post-turn
 * reads give the estimate.
 */
import {
  AgentStatus,
  type DesktopEvent,
} from "@abacus-ai/contract/agent-types";
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import {
  creditAccountKey,
  type CreditTaskKind,
  type CreditThresholdMark,
  thresholdOf,
} from "@abacus-ai/contract/credit-thresholds";
import { abacusPlanTier } from "@abacus-ai/contract/models";

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
  estimate: { perTask: number; kind: CreditTaskKind } | null
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
    // Paid plans never see it; an unread or anonymous account is not guessed at.
    if (account == null || abacusPlanTier(account) !== "free") return;
    const key = creditAccountKey(account);
    const { credits_used: used, credits_granted: granted } = account;
    if (key == null || used == null || granted == null || !(granted > 0))
      return;
    const at = this.deps.now?.() ?? Date.now();
    const estimate = this.estimate(key, used, kind, at);
    const prefs = this.deps.prefs();
    if (prefs == null) return;
    const marks = prefs.get().creditThresholds ?? {};
    const crossed = markAfterRead(marks[key], { used, granted, at }, estimate);
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
    if (crossed != null)
      prefs.update({ creditThresholds: { ...marks, [key]: crossed } });
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
  facts: { onFreePlan(): boolean; kindOf(sessionId: string): SettledTurnKind }
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
    if (!billed.delete(sessionId) || !facts.onFreePlan()) return;
    void watch.turnSettled(sessionId, facts.kindOf(sessionId));
  };
};
