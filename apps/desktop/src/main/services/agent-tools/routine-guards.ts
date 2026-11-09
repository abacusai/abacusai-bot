/**
 * The rules that keep a routine from running away with itself, as pure
 * functions over its runs so they can be tested without a scheduler: an
 * overlapping fire is skipped, an overlong run is failed, a routine that
 * keeps failing or keeps finding nothing is paused, and the agent's own runs
 * and schedules are kept from multiplying what the user asked for.
 */
import {
  withoutNoReply,
  withoutRoutineDone,
} from "@abacus-ai/contract/contract/ai";
import type {
  RoutineRunItem,
  RoutineRunOutcome,
} from "@abacus-ai/contract/contracts";
import {
  ROUTINE_FAILURES_BEFORE_PAUSE,
  ROUTINE_PAUSE_NOTES,
  ROUTINE_QUIET_RUNS_BEFORE_PAUSE,
  type RoutineRun,
} from "@abacus-ai/contract/routines";

/** How long a run may go before it is presumed stuck. */
export const ROUTINE_RUN_TIMEOUT_MS = 30 * 60 * 1000;

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
  timeoutMs: number = ROUTINE_RUN_TIMEOUT_MS,
  /** Time a run spent waiting for the network, which the timeout does not count. */
  networkWaitMs: (sessionId: string) => number = () => 0,
  /** Time the machine slept since the run started (the power clock), not counted either. */
  asleepMs: (startedAt: number) => number = () => 0
): RoutineRunItem[] =>
  runs.filter((run) => {
    if (run.outcome !== "running") return false;
    const startedAt = new Date(run.startedAt).getTime();
    return (
      now - startedAt >
      timeoutMs + networkWaitMs(run.sessionId) + asleepMs(startedAt)
    );
  });

/**
 * How long each run has spent waiting for the network, read off its events:
 * a "waiting for connection" retry starts a wait, anything else ends it. The
 * agent bounds the wait itself, so a run is never reaped mid-wait.
 */
export class NetworkWaitClock {
  private readonly since = new Map<string, number>();
  private readonly total = new Map<string, number>();

  note(sessionId: string, waiting: boolean, now: number): void {
    const started = this.since.get(sessionId);
    if (waiting) {
      if (started == null) this.since.set(sessionId, now);
      return;
    }
    if (started == null) return;
    this.since.delete(sessionId);
    this.total.set(
      sessionId,
      (this.total.get(sessionId) ?? 0) + Math.max(0, now - started)
    );
  }

  waitedMs(sessionId: string, now: number): number {
    const started = this.since.get(sessionId);
    return (
      (this.total.get(sessionId) ?? 0) +
      (started != null ? Math.max(0, now - started) : 0)
    );
  }

  forget(sessionId: string): void {
    this.since.delete(sessionId);
    this.total.delete(sessionId);
  }
}

/** Newest runs failed in a row; runs still going are not counted either way. */
export const consecutiveFailures = (runs: RoutineRunItem[]): number => {
  let count = 0;
  for (const run of runs) {
    // A run the network or a closing app let down says nothing about the routine.
    if (
      run.outcome === "running" ||
      run.outcome === "offline" ||
      run.outcome === "interrupted"
    )
      continue;
    if (run.outcome !== "failed") break;
    count += 1;
  }
  return count;
};

export const shouldPauseAfter = (runs: RoutineRunItem[]): boolean =>
  consecutiveFailures(runs) >= ROUTINE_FAILURES_BEFORE_PAUSE;

/** A run that found nothing new ends on NO_REPLY, after any narration of its checks. */
export const isQuietReply = (reply: string): boolean =>
  withoutNoReply(reply) !== reply;

/**
 * A completed run of a routine with an end condition that found it holds:
 * the routine is retired. A routine without one never ends on a reply.
 */
export const runEndsRoutine = (
  job: { until?: string | null },
  run: { outcome: string; reply: string }
): boolean =>
  job.until != null &&
  run.outcome === "completed" &&
  withoutRoutineDone(run.reply) !== run.reply;

/**
 * Newest completed runs in a row that found nothing new. A failed run is the
 * failure streak's, and one the network or a closing app cut off says
 * nothing either way: neither breaks nor extends it.
 */
export const consecutiveQuietRuns = (
  runs: ReadonlyArray<{ outcome: string; reply: string }>
): number => {
  let count = 0;
  for (const run of runs) {
    if (run.outcome !== "completed") continue;
    if (!isQuietReply(run.reply)) break;
    count += 1;
  }
  return count;
};

/**
 * Whether a routine's runs since the user last resumed it (newest first) have
 * found nothing often enough to pause it. Once the user resumes a routine
 * paused this way they have chosen to keep it polling, so it is not paused
 * for that again.
 */
export const shouldPauseQuiet = (
  runs: ReadonlyArray<{ outcome: string; reply: string }>,
  history: readonly RoutineRun[],
  resumedAt: number
): boolean =>
  consecutiveQuietRuns(runs) >= ROUTINE_QUIET_RUNS_BEFORE_PAUSE &&
  !history.some(
    (entry) =>
      entry.kind === "paused" &&
      entry.result === ROUTINE_PAUSE_NOTES.quiet &&
      entry.at <= resumedAt
  );

/** The agent's code for a turn that waited out its budget for the network. */
const NETWORK_UNREACHABLE_CODE = "network_unreachable";

/**
 * How a closed turn (TurnLedger) files its run: a reply completes it, a
 * network that never came back files it `offline`, the app closing under it
 * `interrupted`, anything else fails it.
 */
export const runOutcomeOf = (ending: {
  kind: string;
  error?: { code?: string };
}): Exclude<RoutineRunOutcome, "running"> => {
  if (ending.kind === "reply") return "completed";
  if (ending.kind === "app_closed") return "interrupted";
  return ending.error?.code === NETWORK_UNREACHABLE_CODE ? "offline" : "failed";
};

/**
 * A run stopped by an empty Abacus.AI balance, which every later fire would
 * hit too. The agent offers the upgrade only then, and only for a model
 * Abacus.AI serves.
 */
export const ranOutOfAbacusCredits = (error: {
  actions?: Array<{ type: string }>;
}): boolean =>
  error.actions?.some((action) => action.type === "upgrade-abacus") === true;

/** Between two runs of one routine, below which another agent run is flagged. */
const AGENT_RUN_MIN_GAP_MS = 10 * 60_000;

/** Agent runs of one routine in a day, past which another is flagged. */
const AGENT_RUNS_PER_DAY = 3;

const DAY_MS = 24 * 60 * 60_000;

/**
 * What the agent is told when it runs a routine soon after another run, or
 * past a few agent runs in a day: the run still starts, and the note says
 * what running it again costs. Null when the run is unremarkable. `runs`
 * newest first, as the store keeps them.
 */
export const agentRunWarning = (
  runs: readonly RoutineRun[],
  now: number
): string | null => {
  const started = runs.filter((run) => run.kind === "started");
  const last = started[0];
  const minutesAgo =
    last != null && now - last.at < AGENT_RUN_MIN_GAP_MS
      ? Math.max(0, Math.round((now - last.at) / 60_000))
      : null;
  const today = started.filter(
    (run) => run.trigger === "agent" && now - run.at < DAY_MS
  ).length;
  if (minutesAgo == null && today < AGENT_RUNS_PER_DAY) return null;
  const parts = [
    ...(minutesAgo != null
      ? [
          minutesAgo === 0
            ? "this routine already ran under a minute ago"
            : `this routine already ran ${minutesAgo} minute${minutesAgo === 1 ? "" : "s"} ago`,
        ]
      : []),
    ...(today > 0
      ? [`you have run it ${today} time${today === 1 ? "" : "s"} today`]
      : []),
  ];
  const said = parts.join(", and ");
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}. Running it again repeats what it sends and spends credits: do not run it again unless the user asked.`;
};
