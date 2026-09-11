/**
 * The rules that keep a routine from running away with itself, as pure
 * functions over its runs so they can be tested without a scheduler: an
 * overlapping fire is skipped, an overlong run is failed, and a routine that
 * keeps failing is paused until someone looks.
 */
import type { RoutineRunItem } from "#shared/contracts";

/** How long a run may go before it is presumed stuck. */
export const ROUTINE_RUN_TIMEOUT_MS = 30 * 60 * 1000;

/** Consecutive failed runs before a routine pauses itself. */
export const ROUTINE_FAILURES_BEFORE_PAUSE = 3;

/** True when a fire now would run beside a run that has not finished. */
export const hasRunInFlight = (runs: RoutineRunItem[]): boolean =>
  runs.some((run) => run.outcome === "running");

/**
 * `startedAt` rather than `updatedAt`: a run that streams a token every
 * minute is still stuck if it has been at it for an hour.
 */
export const stuckRuns = (
  runs: RoutineRunItem[],
  now: number,
  timeoutMs: number = ROUTINE_RUN_TIMEOUT_MS
): RoutineRunItem[] =>
  runs.filter(
    (run) =>
      run.outcome === "running" &&
      now - new Date(run.startedAt).getTime() > timeoutMs
  );

/** Newest runs failed in a row; runs still going are not counted either way. */
export const consecutiveFailures = (runs: RoutineRunItem[]): number => {
  let count = 0;
  for (const run of runs) {
    if (run.outcome === "running") continue;
    if (run.outcome !== "failed") break;
    count += 1;
  }
  return count;
};

export const shouldPauseAfter = (runs: RoutineRunItem[]): boolean =>
  consecutiveFailures(runs) >= ROUTINE_FAILURES_BEFORE_PAUSE;
