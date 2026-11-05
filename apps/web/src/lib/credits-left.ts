/**
 * The "left" beside a turn's credits: an upper bound on the account's balance
 * that only moves down within one grant. Each account read lowers it to what
 * the read says; a turn that ended after the last read began lowers it by the
 * turn's own credits, so a read that trails the spend never raises it again.
 */
import { Store, useStore } from "@tanstack/react-store";

export interface BalanceCeiling {
  account: string;
  granted: number;
  /** The highest `credits_used` read in this grant. */
  used: number;
  left: number;
  /** Epoch ms of the latest read folded in. */
  readAt: number;
  /** Runs already taken off, so each turn counts once. */
  turns: readonly string[];
}

export interface BalanceRead {
  account: string;
  granted: number;
  used: number;
  at: number;
}

/** A period reset (a new month, a renewal) drops `used` far below what was read. */
const isNewPeriod = (ceiling: BalanceCeiling, read: BalanceRead): boolean =>
  read.used < ceiling.used / 2;

export const foldRead = (
  ceiling: BalanceCeiling | null,
  read: BalanceRead
): BalanceCeiling => {
  const left = Math.max(0, read.granted - read.used);
  if (
    ceiling == null ||
    ceiling.account !== read.account ||
    ceiling.granted !== read.granted ||
    isNewPeriod(ceiling, read)
  )
    return { ...read, left, readAt: read.at, turns: [] };
  if (read.at <= ceiling.readAt) return ceiling;
  return {
    ...ceiling,
    used: Math.max(ceiling.used, read.used),
    left: Math.min(ceiling.left, left),
    readAt: read.at,
  };
};

/**
 * A finished turn's own credits off the ceiling, once, and only when the
 * ceiling's last read came before the turn began (a read during it already
 * holds part of its spend).
 */
export const foldTurn = (
  ceiling: BalanceCeiling | null,
  turn: { runId: string; startedAt: number; credits: number }
): BalanceCeiling | null => {
  if (
    ceiling == null ||
    ceiling.turns.includes(turn.runId) ||
    ceiling.readAt > turn.startedAt
  )
    return ceiling;
  return {
    ...ceiling,
    left: Math.max(0, ceiling.left - turn.credits),
    turns: [...ceiling.turns.slice(-49), turn.runId],
  };
};

/**
 * What to show as left after `turn`: null until a read after the turn ended,
 * or the turn taken off a read from before it, bounds the balance.
 */
export const leftAfter = (
  ceiling: BalanceCeiling | null,
  account: string | null,
  turn: { runId: string; endedAt: number }
): number | null => {
  if (ceiling == null || account == null || ceiling.account !== account)
    return null;
  return ceiling.readAt >= turn.endedAt || ceiling.turns.includes(turn.runId)
    ? ceiling.left
    : null;
};

/** In memory for the window's life: a fresh window starts from its first read. */
export const balanceStore = new Store<{ ceiling: BalanceCeiling | null }>({
  ceiling: null,
});

export const useBalanceCeiling = () =>
  useStore(balanceStore, (state) => state.ceiling);
