/**
 * Spec 05 §31.5 f: history entry kinds, the legacy classification migration
 * step 5 applies (and `cron-store`'s read fallback repeats), and the run-row
 * join.
 */
import { describe, expect, it } from "vitest";

import type { RoutineRun } from "#shared/routines";

import {
  attemptForSession,
  classifyLegacyRuns,
  legacyAttemptId,
  legacyKind,
  mintAttemptId,
  parseRunRecord,
  type StoredRun,
} from "./routine-attempts";

const legacy = (
  at: number,
  result: string,
  trigger: StoredRun["trigger"] = "schedule"
): StoredRun => ({ at, trigger, result });

describe("legacyKind", () => {
  it.each([
    ["started session s-1", "started"],
    ["session failed to start: no model", "start-failed"],
    ["skipped: the previous run is still going", "skipped"],
    ["no workspace to run in", "no-workspace"],
    ["failed: the run was stopped after 30 minutes", "timed-out"],
    ["paused: out of Abacus.AI credits", "paused"],
    ["paused after 3 failed runs in a row", "paused"],
    ["something an older build wrote", "unknown"],
    ["failed to start: boom", "unknown"],
  ])("%s → %s", (result, kind) => {
    expect(legacyKind(result)).toBe(kind);
  });
});

describe("classifyLegacyRuns", () => {
  it("mints stable, content-derived ids and leaves id-bearing entries alone", () => {
    const runs = [
      legacy(3_000, "started session s-2"),
      legacy(2_000, "skipped: the previous run is still going"),
      legacy(2_000, "skipped: the previous run is still going"),
    ];
    const first = classifyLegacyRuns("job-1", runs);
    expect(first.changed).toBe(3);
    const ids = first.runs.map((run) => run.id);
    expect(new Set(ids).size).toBe(3);
    for (const id of ids) expect(id).toMatch(/^attempt-[0-9a-f-]{36}$/);
    // Same input, same ids: the step and the read fallback agree.
    expect(classifyLegacyRuns("job-1", runs).runs.map((r) => r.id)).toEqual(
      ids
    );
    // Prepending a newer legacy entry does not move the older ones' ids.
    const prepended = classifyLegacyRuns("job-1", [
      legacy(4_000, "no workspace to run in"),
      ...runs,
    ]);
    expect(prepended.runs.slice(1).map((run) => run.id)).toEqual(ids);
    // A second pass changes nothing.
    const again = classifyLegacyRuns("job-1", first.runs);
    expect(again.changed).toBe(0);
    expect(again.runs).toEqual(first.runs);
    expect(first.runs[0]).toMatchObject({
      kind: "started",
      sessionId: "s-2",
      attemptId: null,
    });
    expect(first.runs[1]).toMatchObject({ kind: "skipped", sessionId: null });
  });

  it("recovers sessions from run records within 2 s and links a legacy timeout", () => {
    const records = [
      // An unknown entry's run, started 1.5 s from its `at`.
      { sessionId: "s-a", startedAt: 10_000 + 1_500, endedAt: 20_000 },
      // The run the reaper stopped: its record ended when the timeout was
      // recorded.
      { sessionId: "s-b", startedAt: 30_000, endedAt: 1_830_000 + 900 },
      // Too far from anything.
      { sessionId: "s-c", startedAt: 90_000, endedAt: 95_000 },
    ];
    const { runs } = classifyLegacyRuns(
      "job-1",
      [
        legacy(1_830_000, "failed: the run was stopped after 30 minutes"),
        legacy(30_000, "started session s-b"),
        legacy(10_000, "an older build's text"),
        legacy(80_000, "an older build's text"),
      ],
      records
    );
    const [timeout, started, recovered, unmatched] = runs as [
      RoutineRun,
      RoutineRun,
      RoutineRun,
      RoutineRun,
    ];
    expect(recovered).toMatchObject({ kind: "unknown", sessionId: "s-a" });
    expect(unmatched).toMatchObject({ kind: "unknown", sessionId: null });
    expect(started).toMatchObject({ kind: "started", sessionId: "s-b" });
    expect(timeout).toMatchObject({
      kind: "timed-out",
      sessionId: "s-b",
      attemptId: started.id,
    });
  });

  it("never lets a record claim a session an entry already names", () => {
    const { runs } = classifyLegacyRuns(
      "job-1",
      [legacy(5_000, "started session s-1"), legacy(5_500, "odd text")],
      [{ sessionId: "s-1", startedAt: 5_100, endedAt: null }]
    );
    expect(runs[1]).toMatchObject({ kind: "unknown", sessionId: null });
  });

  // Codex r1 #16: an id-less entry identical to an older one that already
  // has its derived id (an older build prepended it after the migration).
  it("never gives an id-less entry the id an identical entry already holds", () => {
    const skipped = "skipped: the previous run is still going";
    const migrated = classifyLegacyRuns("job-1", [legacy(2_000, skipped)]);
    const runs = [legacy(2_000, skipped), ...migrated.runs];
    const { runs: out, changed } = classifyLegacyRuns("job-1", runs);
    expect(changed).toBe(1);
    expect(out[1]).toEqual(migrated.runs[0]);
    expect(new Set(out.map((run) => run.id)).size).toBe(2);
    // And the order an entry has among identical ones stays stable.
    expect(classifyLegacyRuns("job-1", out).runs).toEqual(out);
  });

  // Codex r1 #17 / Claude r1 #6: the read fallback persisted derived ids
  // without run records; the step, with records, fills only what is missing.
  it("fills the missing links of an entry the fallback gave a derived id", () => {
    const history = [
      legacy(1_830_000, "failed: the run was stopped after 30 minutes"),
      legacy(30_000, "an older build's text"),
    ];
    const fallback = classifyLegacyRuns("job-1", history).runs;
    expect(fallback.map((run) => run.sessionId)).toEqual([null, null]);
    const records = [
      {
        sessionId: "s-b",
        startedAt: 30_500,
        endedAt: 1_830_000 + 400,
        outcome: "failed" as const,
      },
    ];
    const enriched = classifyLegacyRuns("job-1", fallback, records);
    expect(enriched.changed).toBe(2);
    expect(enriched.runs.map((run) => run.id)).toEqual(
      fallback.map((run) => run.id)
    );
    expect(enriched.runs[1]).toMatchObject({ sessionId: "s-b" });
    expect(enriched.runs[0]).toMatchObject({
      sessionId: "s-b",
      attemptId: fallback[1]!.id,
    });
    // An entry minted with its own id is never touched.
    const minted: RoutineRun = {
      ...fallback[1]!,
      id: mintAttemptId(),
      sessionId: null,
    };
    expect(classifyLegacyRuns("job-1", [minted], records).runs).toEqual([
      minted,
    ]);
  });

  // Claude r1 #23.
  it("gives each record to one timeout, preferring the run the reaper failed", () => {
    const timedOut = "failed: the run was stopped after 30 minutes";
    const { runs } = classifyLegacyRuns(
      "job-1",
      [legacy(100_000, timedOut), legacy(100_500, timedOut)].reverse(),
      [
        // A run that finished normally at the same moment.
        {
          sessionId: "s-done",
          startedAt: 1_000,
          endedAt: 100_100,
          outcome: "completed",
        },
        {
          sessionId: "s-hung",
          startedAt: 2_000,
          endedAt: 100_400,
          outcome: "failed",
        },
      ]
    );
    // Oldest first: the first timeout takes the failed record even though
    // the completed one ended closer to it; the second stays unlinked.
    expect(runs.map((run) => run.sessionId)).toEqual([null, "s-hung"]);
  });

  it("links a legacy start failure to the session it stored just before", () => {
    const { runs } = classifyLegacyRuns(
      "job-1",
      [
        legacy(200_000, "session failed to start: no model"),
        legacy(100_000, "session failed to start: no model"),
      ],
      [],
      [
        { sessionId: "s-1", createdAt: 99_000, runOutcome: "failed" },
        { sessionId: "s-ok", createdAt: 150_000, runOutcome: "completed" },
        { sessionId: "s-2", createdAt: 190_000, runOutcome: "failed" },
        // Made after the entry: not its session.
        { sessionId: "s-3", createdAt: 250_000, runOutcome: "failed" },
      ]
    );
    expect(runs.map((run) => run.sessionId)).toEqual(["s-2", "s-1"]);
  });
});

describe("ids and the run-row join", () => {
  it("mints attempt-<uuid>", () => {
    expect(mintAttemptId()).toMatch(
      /^attempt-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
    );
    expect(
      legacyAttemptId("job", { at: 1, trigger: "manual", result: "r" }, 0)
    ).not.toBe(
      legacyAttemptId("job", { at: 1, trigger: "manual", result: "r" }, 1)
    );
  });

  it("joins a session to its attempt, preferring the latest follow-up's result", () => {
    const attempt: RoutineRun = {
      id: "attempt-a",
      at: 1,
      trigger: "schedule",
      result: "started session s-1",
      kind: "started",
      sessionId: "s-1",
      attemptId: null,
    };
    const timeout: RoutineRun = {
      ...attempt,
      id: "attempt-t",
      at: 2,
      result: "failed: the run was stopped after 30 minutes",
      kind: "timed-out",
      attemptId: "attempt-a",
    };
    expect(attemptForSession([attempt], "s-1")).toEqual({
      attemptId: "attempt-a",
      result: "started session s-1",
    });
    expect(attemptForSession([timeout, attempt], "s-1")).toEqual({
      attemptId: "attempt-a",
      result: "failed: the run was stopped after 30 minutes",
    });
    expect(attemptForSession([timeout, attempt], "s-2")).toEqual({
      attemptId: null,
      result: null,
    });
  });

  it("parses the run record format recordRoutineRun writes", () => {
    expect(
      parseRunRecord(
        [
          "# Run at 2026-09-01T09:00:00.000Z",
          "",
          "- Outcome: completed",
          "- Ended: 2026-09-01T09:05:00.000Z",
          "- Session: s-9",
          "",
          "done",
        ].join("\n")
      )
    ).toEqual({
      sessionId: "s-9",
      startedAt: Date.parse("2026-09-01T09:00:00.000Z"),
      endedAt: Date.parse("2026-09-01T09:05:00.000Z"),
      outcome: "completed",
    });
    expect(parseRunRecord("# Run at nonsense\n- Session: s")).toBeNull();
    expect(parseRunRecord("no heading")).toBeNull();
  });
});
