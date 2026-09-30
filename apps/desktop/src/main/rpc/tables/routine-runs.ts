import type { RoutineRunRow } from "#shared/contract/rows";

import type { TableSources } from "./sources";

/**
 * A routine's run sessions, as `ServiceHost.listRoutineRuns` maps them, for
 * every routine at once. The routine's editor session is not a run.
 */
export const readRoutineRunRows = (sources: TableSources): RoutineRunRow[] =>
  sources
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
    }));
