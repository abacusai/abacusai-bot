/**
 * The Abacus credit balance as the agent process last heard it. The desktop
 * says so at spawn (ABACUSAI_BOT_CREDITS) and after every account read (the
 * `credit_balance` command); a run on billed credits can ask for a fresher read.
 */

export interface CreditBalance {
  remaining: number;
  granted: number;
  /** When the host read the account, in epoch milliseconds. */
  at: number;
  /** The plan's monthly credits, when the server says; absent on a free plan. */
  planCredits?: number;
  /** A plan the user pays for (contract creditMilestonePlan): the user is told when the run wraps up. */
  paid?: boolean;
}

/**
 * What "running low" is measured against: the plan's own credits, never what
 * was bought on top. Someone who bought 300,000 is not low at 30,000. A promoted
 * first month grants less than the plan, so the smaller of the two. The
 * app's credit milestones measure the same base (milestoneBalance in
 * packages/contract/src/credit-thresholds.ts).
 */
export const lowCreditBase = (balance: CreditBalance): number =>
  balance.planCredits != null
    ? Math.min(balance.planCredits, balance.granted)
    : balance.granted;

const finite = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value);

const parse = (raw: unknown): CreditBalance | null => {
  const value = raw as Partial<CreditBalance> | null | undefined;
  return value != null &&
    finite(value.remaining) &&
    finite(value.granted) &&
    finite(value.at) &&
    value.granted > 0
    ? {
        remaining: value.remaining,
        granted: value.granted,
        at: value.at,
        ...(finite(value.planCredits) && value.planCredits > 0
          ? { planCredits: value.planCredits }
          : {}),
        ...(value.paid === true ? { paid: true } : {}),
      }
    : null;
};

const fromEnv = (raw: string | undefined): CreditBalance | null => {
  if (raw == null || raw === "") return null;
  try {
    return parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

let balance = fromEnv(process.env.ABACUSAI_BOT_CREDITS);

export const hostCreditBalance = (): CreditBalance | null => balance;

/** The host's latest read; an older or unrecognised one leaves the last. */
export function setHostCreditBalance(next: unknown): void {
  const parsed = parse(next);
  if (parsed != null && (balance == null || parsed.at >= balance.at))
    balance = parsed;
}

/** Below a quarter left the balance moves fast enough to re-read every minute. */
const STALE_MS = 3 * 60_000;
const STALE_LOW_MS = 60_000;
const LOW_SHARE = 0.25;

let refresher: (() => Promise<unknown>) | null = null;
let askedAt = Number.NEGATIVE_INFINITY;

/** The session's way to ask the host for a fresh read; null when no host answers. */
export function setCreditRefresher(
  next: (() => Promise<unknown>) | null
): void {
  refresher = next;
  askedAt = Number.NEGATIVE_INFINITY;
}

/** Asks the host to re-read the account when the balance is old for how low it is. */
export function refreshCreditBalanceIfStale(now = Date.now()): void {
  if (refresher == null) return;
  const ttl =
    balance != null && balance.remaining < lowCreditBase(balance) * LOW_SHARE
      ? STALE_LOW_MS
      : STALE_MS;
  // Spaced by our own asks too: an account that reports no balance never freshens.
  if (now - Math.max(balance?.at ?? Number.NEGATIVE_INFINITY, askedAt) < ttl)
    return;
  askedAt = now;
  // The answer is the snapshot; the broadcast that follows carries it too.
  void refresher().then(setHostCreditBalance, () => {});
}
