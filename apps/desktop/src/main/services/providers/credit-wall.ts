/**
 * The account's credit wall, owned here and kept in the prefs row: when the
 * Abacus credits ran out (`creditsExhaustedAt`) and whether the user chose
 * the free models at it (`freeLaneChosenAt`). Every agent reads it (spawn
 * env, then the `credit_wall` command), so chats, bots and routines share one
 * answer; the sidebar card reads the same row on every launch.
 */
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";

import { ranOutOfAbacusCredits } from "../agent-tools/routine-guards";
import type { CreditSnapshot } from "./abacus";

/** As the agent's CREDIT_WALL_TTL_MS: a wall, and a choice at it, hold a day. */
export const CREDIT_WALL_TTL_MS = 24 * 60 * 60_000;

/**
 * An account read this long after the wall is fresh enough to trust: the
 * platform caches the signed-in account for a few minutes.
 */
const ACCOUNT_READ_LAG_MS = 5 * 60_000;

export interface CreditWall {
  exhaustedAt: number | null;
  freeLaneChosenAt: number | null;
}

export const creditWallOf = (row: PrefsRow): CreditWall => ({
  exhaustedAt: row.creditsExhaustedAt,
  // Absent on a row written before the field existed.
  freeLaneChosenAt: row.freeLaneChosenAt ?? null,
});

const live = (at: number | null, now: number): boolean =>
  at != null && now - at < CREDIT_WALL_TTL_MS;

/**
 * A turn, in any session, ended at the credit wall: stamp it, unless a wall
 * already stands (the first refusal of the day is the one that counts).
 */
export const wallAfterError = (
  row: PrefsRow,
  error: { actions?: Array<{ type: string }> } | undefined,
  now: number
): PrefsPatch | null =>
  error != null &&
  ranOutOfAbacusCredits(error) &&
  !live(row.creditsExhaustedAt, now)
    ? { creditsExhaustedAt: now, freeLaneChosenAt: null }
    : null;

/** An account read after the wall shows credits again: the wall is gone. */
export const wallAfterAccountRead = (
  row: PrefsRow,
  snapshot: CreditSnapshot
): PrefsPatch | null => {
  const at = row.creditsExhaustedAt;
  if (at == null || snapshot.remaining <= 0) return null;
  if (snapshot.at - at < ACCOUNT_READ_LAG_MS) return null;
  return { creditsExhaustedAt: null, freeLaneChosenAt: null };
};

/**
 * A routine fired now would stop at the wall: the credits are out and the
 * free models were not chosen. A wall past its day stands while the account
 * still reads empty; agents only ask Abacus again, and hear the same no.
 */
export const routineStopsAtWall = (
  wall: CreditWall,
  snapshot: CreditSnapshot | null,
  now: number
): boolean =>
  wall.exhaustedAt != null &&
  !live(wall.freeLaneChosenAt, now) &&
  (live(wall.exhaustedAt, now) || snapshot?.remaining === 0);

/** The wall went, or the free models were chosen: routines run again. */
export const holdLifted = (row: PrefsRow): boolean =>
  row.routineCreditHold != null &&
  (row.creditsExhaustedAt == null || row.freeLaneChosenAt != null);

/** Whether a prefs write moved the wall, which every agent must hear. */
export const wallMoved = (row: PrefsRow, previous: PrefsRow): boolean => {
  const next = creditWallOf(row);
  const before = creditWallOf(previous);
  return (
    next.exhaustedAt !== before.exhaustedAt ||
    next.freeLaneChosenAt !== before.freeLaneChosenAt
  );
};
