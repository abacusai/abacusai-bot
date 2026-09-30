import type { RoutineRunRow } from "#shared/contract/rows";
import type { RoutineRun } from "#shared/routines";

import { attemptForSession } from "../../services/agent-tools/routine-attempts";
import type { TableSources } from "./sources";

/**
 * A routine's run sessions, as `ServiceHost.listRoutineRuns` maps them, for
 * every routine at once, each joined to its attempt in the routine's history
 * by session id (spec 05 §31.5 f). The routine's editor session is not a run.
 */
export const readRoutineRunRows = (sources: TableSources): RoutineRunRow[] => {
  const history = new Map<string, readonly RoutineRun[]>(
    sources.listRoutines().map((routine) => [routine.id, routine.runs])
  );
  return sources
    .listAllAgentSessions()
    .filter((session) => session.routineId != null && session.editorFor == null)
    .map((session) => ({
      sessionId: session.id,
      routineId: session.routineId!,
      workspaceId: session.workspaceId,
      startedAt: session.createdAt,
      updatedAt: session.updatedAt,
      outcome: session.runOutcome ?? "completed",
      trigger: session.runTrigger,
      ...attemptForSession(history.get(session.routineId!) ?? [], session.id),
    }));
};
