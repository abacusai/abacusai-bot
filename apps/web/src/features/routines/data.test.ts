import { nextRun } from "@abacus-ai/contract/routines/cron";
import * as v from "valibot";
import { describe, expect, it } from "vitest";

import {
  fixtureRoutines,
  fixtureSessions,
} from "#renderer/data/fixture-db/rows";
import { CODING_ROUTINE_TEMPLATES } from "#renderer/lib/routines/templates";

import { routineState, runsView, scheduleLabel, stats } from "./data";
import {
  RoutineFormSchema,
  routineFormSchema,
  valuesForRoutine,
  dirtyPatch,
  nextPreview,
} from "./schema";

describe("R5-T6 routine state and local day stats", () => {
  it("uses attention before running and paused", () => {
    const routine = { ...fixtureRoutines()[0]!, enabled: false };
    const session = {
      ...fixtureSessions()[0]!,
      routineId: routine.id,
      turn: {
        phase: "waiting_permission" as const,
        isBusy: true,
        updatedAt: "now",
      },
    };
    expect(routineState(routine, [], [session])).toBe("needs-you");
    expect(routineState(routine, [], [])).toBe("paused");
  });
  it("says a routine held for the network is waiting, not failed", () => {
    const routine = {
      ...fixtureRoutines()[0]!,
      enabled: true,
      waitingForConnection: true,
    };
    expect(routineState(routine, [], [])).toBe("waiting");
    expect(routineState({ ...routine, enabled: false }, [], [])).toBe("paused");
  });
  it.each([
    ["once", { schedule: null, runAt: 123 }],
    ["webhook", { schedule: null, webhookToken: "token" }],
    ["manual", { schedule: null }],
    ["scheduled", {}],
  ] as const)("derives %s", (state, patch) =>
    expect(routineState({ ...fixtureRoutines()[0]!, ...patch }, [], [])).toBe(
      state
    )
  );
  it("includes a future fire today but excludes midnight tomorrow", () => {
    const now = new Date(2026, 9, 1, 12);
    const row = fixtureRoutines()[0]!;
    expect(
      stats([{ ...row, nextRunAt: +new Date(2026, 9, 1, 18) }], now).fireToday
    ).toBe(1);
    expect(
      stats([{ ...row, nextRunAt: +new Date(2026, 9, 2) }], now).fireToday
    ).toBe(0);
  });
});
describe("R5-T10 attempt history", () => {
  it("folds timeouts into one attempt and keeps pause as a note", () => {
    const row = fixtureRoutines()[0]!;
    row.recentRuns = [
      {
        id: "pause",
        kind: "paused",
        at: 3,
        trigger: "schedule",
        result: "Paused",
        sessionId: null,
        attemptId: null,
      },
      {
        id: "timeout",
        kind: "timed-out",
        at: 2,
        trigger: "schedule",
        result: "Timed out",
        sessionId: "run",
        attemptId: "start",
      },
      {
        id: "start",
        kind: "started",
        at: 1,
        trigger: "schedule",
        result: "Started",
        sessionId: "run",
        attemptId: null,
      },
    ];
    const list = runsView(row, [
      {
        routineId: row.id,
        sessionId: "run",
        workspaceId: "w",
        startedAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
        outcome: "running",
        trigger: "schedule",
        attemptId: "start",
        result: null,
      },
    ]);
    expect(list).toHaveLength(2);
    expect(list[0]?.note).toBe(true);
    expect(list[1]).toMatchObject({
      id: "start",
      outcome: "failed",
      result: "Timed out",
    });
  });
  it("lists a skipped fire without making a report target", () => {
    const row = fixtureRoutines()[0]!;
    row.recentRuns = [
      {
        id: "skip",
        kind: "skipped",
        at: 1,
        trigger: "manual",
        result: "Already running",
        sessionId: null,
        attemptId: null,
      },
    ];
    expect(runsView(row, [])[0]).toMatchObject({
      outcome: "skipped",
      sessionId: null,
    });
  });
  it("shows a fire the credits kept from running as its own", () => {
    const row = fixtureRoutines()[0]!;
    row.recentRuns = [
      {
        id: "held",
        kind: "skipped-credits",
        at: 2,
        trigger: "schedule",
        result: "skipped: out of Abacus.AI credits",
        sessionId: null,
        attemptId: null,
      },
    ];
    expect(runsView(row, [])[0]).toMatchObject({
      outcome: "skipped-credits",
      sessionId: null,
    });
    expect(routineState(row, [], [])).toBe("waiting-credits");
  });
  it("shows a fire the network kept from running, and a run it cut short, as their own", () => {
    const row = fixtureRoutines()[0]!;
    row.recentRuns = [
      {
        id: "held",
        kind: "skipped-offline",
        at: 2,
        trigger: "schedule",
        result: "skipped: no network connection before the next run",
        sessionId: null,
        attemptId: null,
      },
      {
        id: "start",
        kind: "started",
        at: 1,
        trigger: "schedule",
        result: "started session run",
        sessionId: "run",
        attemptId: null,
      },
    ];
    const list = runsView(row, [
      {
        routineId: row.id,
        sessionId: "run",
        workspaceId: "w",
        startedAt: new Date(1).toISOString(),
        updatedAt: new Date(2).toISOString(),
        outcome: "offline",
        trigger: "schedule",
        attemptId: "start",
        result: null,
      },
    ]);
    expect(list.map((view) => view.outcome)).toEqual([
      "skipped-offline",
      "offline",
    ]);
    expect(routineState(row, [], [])).not.toBe("failed");
  });
});
describe("R5-T8/T9 form values", () => {
  it("refuses whitespace-only instructions and persists parsed trimming", () => {
    const draft = valuesForRoutine();
    expect(
      v.safeParse(RoutineFormSchema, { ...draft, prompt: "   " }).success
    ).toBe(false);
    expect(
      v.parse(RoutineFormSchema, {
        ...draft,
        name: " Brief ",
        prompt: " Summarise ",
      })
    ).toMatchObject({ name: "Brief", prompt: "Summarise" });
  });
  it("saves a 1.0.85 routine over the caps until its long text is edited", () => {
    // 1.0.85 had no caps on either field.
    const saved = valuesForRoutine({
      ...fixtureRoutines()[0]!,
      name: "n".repeat(120),
      prompt: "p".repeat(20000),
    });
    const schema = routineFormSchema(saved);
    expect(
      v.safeParse(schema, { ...saved, webhook: !saved.webhook }).success
    ).toBe(true);
    expect(
      v.safeParse(schema, { ...saved, name: `${saved.name}!` }).success
    ).toBe(false);
    expect(
      v.safeParse(schema, { ...saved, prompt: `${saved.prompt}!` }).success
    ).toBe(false);
    expect(v.safeParse(RoutineFormSchema, saved).success).toBe(false);
  });
  it("preserves a custom cron, previews with main's parser and patches only edits", () => {
    const row = { ...fixtureRoutines()[0]!, schedule: "*/7 4,9 * * 1-5" };
    const value = valuesForRoutine(row);
    expect(value.schedule.preset).toBe("custom");
    expect(dirtyPatch(value, value)).toEqual({});
    const now = new Date(2026, 9, 1);
    expect(nextPreview(value.schedule, now)).toEqual(
      nextRun(row.schedule, now)
    );
    expect(dirtyPatch({ ...value, name: "Changed" }, value)).toEqual({
      name: "Changed",
    });
  });
});

describe("a routine's schedule in words", () => {
  const t = ((key: string, options?: { cron?: string }) =>
    options?.cron != null ? `${key} ${options.cron}` : key) as never;

  it("says a coding routine's own schedule in words, and any other cron as written", () => {
    const site = CODING_ROUTINE_TEMPLATES.find((x) => x.id === "site-down")!;
    const row = { schedule: site.custom!, runAt: null, prompt: site.prompt };
    expect(scheduleLabel(row, t, "en-US")).toBe(
      "routines.templates.site-down.when"
    );
    // The same cron with the user's own words is theirs: shown as written.
    expect(scheduleLabel({ ...row, prompt: "ping it" }, t, "en-US")).toBe(
      "phase5.customCron */5 * * * *"
    );
  });
});
