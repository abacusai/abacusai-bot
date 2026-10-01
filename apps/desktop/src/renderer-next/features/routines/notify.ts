import { isCheckInRoutine } from "#next/lib/bots/check-in";
import type { RunFinishedNotice } from "#shared/contract/ai";
import type { RoutinesEvent } from "#shared/contract/routines";
import type { RoutineRow } from "#shared/contract/rows";
export const routineOwns = (routine: RoutineRow | undefined) =>
  !!routine && !(routine.botId && isCheckInRoutine(routine, routine.botId));
export const createFireHandler = (
  routines: () => readonly RoutineRow[],
  play: (id: string, botId: string | null) => void,
  seen = new Set<string>()
) => {
  return (event: RoutinesEvent) => {
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
