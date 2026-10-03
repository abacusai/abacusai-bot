import { expect, it, vi } from "vitest";

import { readRoutineRunRows } from "./routine-runs";
import type { TableSources } from "./sources";

it("joins run rows from history without computing display fields or cron next times", () => {
  const listRoutines = vi.fn(() => {
    throw new Error("display read should not run");
  });
  const sources = {
    listRoutines,
    listRoutineHistories: () => [
      {
        id: "routine",
        runs: [
          { id: "attempt", kind: "started", sessionId: "s", result: "started" },
        ],
      },
    ],
    listAllAgentSessions: () => [
      {
        id: "s",
        routineId: "routine",
        workspaceId: "w",
        createdAt: "now",
        updatedAt: "now",
        runOutcome: "completed",
      },
    ],
  } as unknown as TableSources;
  expect(readRoutineRunRows(sources)).toMatchObject([
    { sessionId: "s", attemptId: "attempt", result: "started" },
  ]);
  expect(listRoutines).not.toHaveBeenCalled();
});
