import { describe, expect, it } from "vitest";

import type { RoutineRunItem } from "#shared/contracts";

import {
  consecutiveFailures,
  hasRunInFlight,
  ROUTINE_FAILURES_BEFORE_PAUSE,
  shouldPauseAfter,
  stuckRuns,
} from "./routine-guards";

const run = (
  outcome: RoutineRunItem["outcome"],
  startedAt = "2026-09-03T09:00:00.000Z"
): RoutineRunItem => ({
  sessionId: `s-${startedAt}-${outcome}`,
  workspaceId: "w",
  startedAt,
  updatedAt: startedAt,
  outcome,
  trigger: "schedule",
});

describe("the overlap guard", () => {
  it("sees a run still going", () => {
    expect(hasRunInFlight([run("completed"), run("running")])).toBe(true);
    expect(hasRunInFlight([run("completed"), run("failed")])).toBe(false);
    expect(hasRunInFlight([])).toBe(false);
  });
});

describe("the stuck-run timeout", () => {
  it("names only the running runs past the limit", () => {
    const now = new Date("2026-09-03T10:00:00.000Z").getTime();
    const stuck = stuckRuns(
      [
        run("running", "2026-09-03T09:00:00.000Z"),
        run("running", "2026-09-03T09:50:00.000Z"),
        run("completed", "2026-09-03T08:00:00.000Z"),
      ],
      now,
      30 * 60 * 1000
    );
    expect(stuck.map((r) => r.startedAt)).toEqual(["2026-09-03T09:00:00.000Z"]);
  });
});

describe("the failure streak", () => {
  // Newest first, the way the runs list comes.
  it("counts failures from the newest finished run back", () => {
    expect(
      consecutiveFailures([run("failed"), run("failed"), run("completed")])
    ).toBe(2);
    expect(consecutiveFailures([run("completed"), run("failed")])).toBe(0);
    // A run still going does not break or extend the streak.
    expect(
      consecutiveFailures([run("running"), run("failed"), run("failed")])
    ).toBe(2);
  });

  it("pauses at the threshold and not before", () => {
    const failures = Array.from({ length: ROUTINE_FAILURES_BEFORE_PAUSE }, () =>
      run("failed")
    );
    expect(shouldPauseAfter(failures)).toBe(true);
    expect(shouldPauseAfter(failures.slice(1))).toBe(false);
  });
});
