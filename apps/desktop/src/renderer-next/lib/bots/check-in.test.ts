import * as v from "valibot";
/**
 * R3-T9: the model-facing strings equal the immutable fixtures captured from
 * the pre-migration old renderer (§9.5); the check-in draft reads stored
 * routines and saves by the §10.3 rules.
 */
import { describe, expect, it } from "vitest";

import checkInPromptFixture from "./__fixtures__/legacy-model-strings/check-in-prompt.txt?raw";
import describeFixture from "./__fixtures__/legacy-model-strings/describe-check-in.json";
import nameOnlyFixture from "./__fixtures__/legacy-model-strings/name-only-mission.txt?raw";
import {
  CHECK_IN_PROMPT,
  checkInFromRoutine,
  checkInPersistence,
  CheckInDraftSchema,
  DEFAULT_CHECK_IN,
  describeCheckIn,
  findCheckIn,
  isCheckInRoutine,
  NAME_ONLY_MISSION,
  scheduleFromCheckIn,
  withMinute,
  type CheckInDraft,
  type CheckInPreset,
} from "./check-in";
import type { Weekday } from "./schedule";

const routine = (
  patch: Partial<{
    id: string;
    schedule: string | null;
    enabled: boolean;
    botId: string | null;
    prompt: string;
    createdAt: number;
  }> = {}
) => ({
  id: "routine-1",
  schedule: "0 9 * * 1-5",
  enabled: true,
  botId: "bot-1",
  prompt: CHECK_IN_PROMPT,
  createdAt: 1,
  ...patch,
});

const draft = (patch: Partial<CheckInDraft> = {}): CheckInDraft => ({
  ...DEFAULT_CHECK_IN,
  ...patch,
});

describe("model-facing strings (fixtures)", () => {
  it("match the pre-migration bytes", () => {
    expect(NAME_ONLY_MISSION).toBe(nameOnlyFixture);
    expect(CHECK_IN_PROMPT).toBe(checkInPromptFixture);
  });

  it("describe every preset as the old dialog did", () => {
    expect(describeFixture.length).toBeGreaterThan(10);
    for (const { input, output } of describeFixture)
      expect(
        describeCheckIn({
          preset: input.preset as CheckInPreset,
          time: input.time,
          weekday: input.weekday as Weekday,
        })
      ).toBe(output);
  });
});

describe("finding the check-in", () => {
  it("matches the bot and the exact prompt", () => {
    expect(isCheckInRoutine(routine(), "bot-1")).toBe(true);
    expect(isCheckInRoutine(routine(), "bot-2")).toBe(false);
    expect(isCheckInRoutine(routine({ prompt: "check in" }), "bot-1")).toBe(
      false
    );
  });

  it("takes the oldest of several", () => {
    const found = findCheckIn(
      [
        routine({ id: "b", createdAt: 5 }),
        routine({ id: "a", createdAt: 2 }),
        routine({ id: "c", createdAt: 1, botId: "bot-2" }),
      ],
      "bot-1"
    );
    expect(found?.id).toBe("a");
    expect(findCheckIn([], "bot-1")).toBeNull();
  });
});

describe("checkInFromRoutine", () => {
  it("reads none as off, enabled", () => {
    expect(checkInFromRoutine(null)).toEqual(DEFAULT_CHECK_IN);
    expect(DEFAULT_CHECK_IN).toMatchObject({
      preset: "off",
      time: "09:00",
      weekday: 1,
      enabled: true,
    });
  });

  it("reads each preset and carries enabled", () => {
    expect(
      checkInFromRoutine(routine({ schedule: "30 8 * * 1-5", enabled: false }))
    ).toEqual({
      preset: "weekdays",
      time: "08:30",
      weekday: 1,
      custom: null,
      enabled: false,
    });
    expect(checkInFromRoutine(routine({ schedule: "15 * * * *" }))).toEqual(
      expect.objectContaining({ preset: "hourly", time: "09:15" })
    );
    expect(checkInFromRoutine(routine({ schedule: "0 10 * * 3" }))).toEqual(
      expect.objectContaining({ preset: "weekly", weekday: 3, time: "10:00" })
    );
  });

  it("keeps a non-preset cron as custom", () => {
    expect(checkInFromRoutine(routine({ schedule: "*/15 * * * *" }))).toEqual(
      expect.objectContaining({
        preset: "custom",
        custom: "*/15 * * * *",
        enabled: true,
      })
    );
  });

  it("round-trips presets through scheduleFromCheckIn", () => {
    for (const schedule of [
      "15 * * * *",
      "0 9 * * *",
      "30 8 * * 1-5",
      "0 10 * * 0",
    ])
      expect(
        scheduleFromCheckIn(checkInFromRoutine(routine({ schedule })))
      ).toBe(schedule);
    expect(scheduleFromCheckIn(draft())).toBeNull();
    expect(
      scheduleFromCheckIn(draft({ preset: "custom", custom: "0 9 1 * *" }))
    ).toBe("0 9 1 * *");
  });

  it("sets hourly's minute", () => {
    expect(withMinute("09:00", 45)).toBe("09:45");
    expect(withMinute("09:00", 99)).toBe("09:59");
    expect(withMinute("17:30", -3)).toBe("17:00");
  });

  it("validates the draft", () => {
    expect(v.safeParse(CheckInDraftSchema, draft()).success).toBe(true);
    expect(
      v.safeParse(CheckInDraftSchema, draft({ time: "25:00" })).success
    ).toBe(false);
  });
});

describe("checkInPersistence (§10.3)", () => {
  it("does nothing when untouched", () => {
    expect(
      checkInPersistence(routine(), draft({ preset: "off" }), false)
    ).toEqual({ kind: "none" });
  });

  it("none → preset inserts, enabled by default", () => {
    expect(
      checkInPersistence(null, draft({ preset: "daily", time: "08:00" }), true)
    ).toEqual({ kind: "insert", schedule: "0 8 * * *", enabled: true });
    expect(checkInPersistence(null, draft(), true)).toEqual({ kind: "none" });
  });

  it("exists → off deletes", () => {
    expect(checkInPersistence(routine(), draft(), true)).toEqual({
      kind: "delete",
      id: "routine-1",
    });
  });

  it("same schedule and enabled does nothing", () => {
    const before = routine();
    expect(
      checkInPersistence(before, checkInFromRoutine(before), true)
    ).toEqual({ kind: "none" });
  });

  it("pause-only writes enabled only", () => {
    const before = routine();
    expect(
      checkInPersistence(
        before,
        { ...checkInFromRoutine(before), enabled: false },
        true
      )
    ).toEqual({ kind: "update", id: "routine-1", enabled: false });
  });

  it("resume-only writes enabled only", () => {
    const before = routine({ enabled: false });
    expect(
      checkInPersistence(
        before,
        { ...checkInFromRoutine(before), enabled: true },
        true
      )
    ).toEqual({ kind: "update", id: "routine-1", enabled: true });
  });

  it("a schedule change on a paused check-in stays paused", () => {
    const before = routine({ enabled: false });
    expect(
      checkInPersistence(
        before,
        { ...checkInFromRoutine(before), preset: "daily", time: "07:00" },
        true
      )
    ).toEqual({ kind: "update", id: "routine-1", schedule: "0 7 * * *" });
  });

  it("leaves a custom schedule alone", () => {
    const before = routine({ schedule: "*/15 * * * *" });
    expect(
      checkInPersistence(before, checkInFromRoutine(before), true)
    ).toEqual({ kind: "none" });
    // …unless a preset is picked.
    expect(
      checkInPersistence(
        before,
        { ...checkInFromRoutine(before), preset: "hourly", time: "09:00" },
        true
      )
    ).toEqual({ kind: "update", id: "routine-1", schedule: "0 * * * *" });
  });
});
