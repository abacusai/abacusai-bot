import type { RunFinishedNotice } from "@abacus-ai/contract/contract/ai";
import type { RoutinesEvent } from "@abacus-ai/contract/contract/routines";
import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import type { HostedRoutineRun } from "@abacus-ai/contract/routines";

import { isCheckInRoutine } from "#renderer/lib/bots/check-in";

import { hostedRunFailed } from "./hosted";
export const routineOwns = (routine: RoutineRow | undefined) =>
  !!routine && !(routine.botId && isCheckInRoutine(routine, routine.botId));
export const createFireHandler = (
  routines: () => readonly RoutineRow[],
  play: (id: string, botId: string | null) => void,
  seen = new Set<string>()
) => {
  return (event: RoutinesEvent) => {
    if (event.type !== "run-started") return;
    if (seen.has(event.attemptId)) return;
    seen.add(event.attemptId);
    if (event.trigger !== "schedule" && event.trigger !== "webhook") return;
    const routine = routines().find((r) => r.id === event.routineId);
    if (routineOwns(routine)) play(event.routineId, routine?.botId ?? null);
  };
};
export const completionNotice = (
  notice: RunFinishedNotice,
  routines: readonly RoutineRow[]
) => {
  const routine = routines.find((r) => r.id === notice.routineId);
  return routineOwns(routine) && notice.outcome !== "cancelled"
    ? {
        routine: routine!,
        kind:
          notice.outcome === "error" ? ("failed" as const) : ("done" as const),
      }
    : null;
};

/** Notices remembered as given; far more than a session sees. */
const SEEN_KEPT = 500;

/** Remember a notice as given; false when it was already. Only the latest are kept. */
export const remember = (seen: Set<string>, key: string): boolean => {
  if (seen.has(key)) return false;
  seen.add(key);
  for (const old of seen) {
    if (seen.size <= SEEN_KEPT) break;
    seen.delete(old);
  }
  return true;
};

/** A run worth telling of: not one that finished with nothing to send (`notify: relevant`). */
export const hostedRunNotable = (
  run: Pick<HostedRoutineRun, "status" | "delivered">
): boolean => run.delivered !== false || hostedRunFailed(run);

const hostedTarget = (
  run: HostedRoutineRun,
  routines: readonly RoutineRow[]
) => {
  const routine = routines.find((r) => r.id === run.routineId);
  return {
    run,
    routineId: routine?.id ?? run.routineId,
    name: routine?.name ?? run.name ?? "",
    botId: routine?.botId ?? null,
  };
};

/**
 * A hosted run that finished on the server: the notice for it, once by run
 * id. Its result already went out by WhatsApp or email; this is the in-app
 * echo and the unread mark. A run that sent nothing gets neither.
 */
export const hostedRunNotice = (
  event: RoutinesEvent,
  routines: readonly RoutineRow[],
  seen: Set<string>
) => {
  if (event.type !== "hosted-run" || !remember(seen, event.run.id)) return null;
  return hostedRunNotable(event.run) ? hostedTarget(event.run, routines) : null;
};

/** Runs that finished while the app was away: one summary, with each one's unread mark. */
export const hostedAwayNotice = (
  event: RoutinesEvent,
  routines: readonly RoutineRow[],
  seen: Set<string>
) => {
  if (event.type !== "hosted-away") return null;
  const runs = event.runs
    .filter((run) => remember(seen, run.id) && hostedRunNotable(run))
    .map((run) => hostedTarget(run, routines));
  return runs.length > 0 ? runs : null;
};
