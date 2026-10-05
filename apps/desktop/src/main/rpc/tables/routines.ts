import type { RoutineRow } from "@abacus-ai/contract/contract/rows";

import type { TableSources } from "./sources";

/** Rows stay small: the run log is capped to the newest 20. */
export const RECENT_RUNS = 20;

/** Re-diffed on this period too: `nextRunAt` moves with the clock. */
export const ROUTINES_CLOCK_MS = 60_000;

export const readRoutineRows = (sources: TableSources): RoutineRow[] =>
  sources.listRoutines().map(({ runs, ...routine }) => ({
    ...routine,
    // Stored newest first (cron-store recordRun prepends).
    recentRuns: runs.slice(0, RECENT_RUNS),
  }));
