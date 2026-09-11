import { describe, expect, it } from "vitest";

import {
  composeCron,
  composeSchedule,
  decomposeSchedule,
  fromLocalDateTime,
  toLocalDateTime,
  DEFAULT_SCHEDULE,
  decomposeCron,
  formatTime,
  weekdayName,
} from "./routine-schedule";

describe("routine schedule presets", () => {
  it("composes each preset into cron", () => {
    const at = { ...DEFAULT_SCHEDULE, time: "17:30" };
    expect(composeCron({ ...at, preset: "manual" })).toBeNull();
    expect(composeCron({ ...at, preset: "hourly" })).toBe("30 * * * *");
    expect(composeCron({ ...at, preset: "daily" })).toBe("30 17 * * *");
    expect(composeCron({ ...at, preset: "weekdays" })).toBe("30 17 * * 1-5");
    expect(composeCron({ ...at, preset: "weekly", weekday: 5 })).toBe(
      "30 17 * * 5"
    );
    expect(
      composeCron({ ...at, preset: "custom", custom: " */15 * * * * " })
    ).toBe("*/15 * * * *");
    expect(composeCron({ ...at, preset: "custom", custom: "  " })).toBeNull();
  });

  it("falls back to 09:00 when the time field is garbage", () => {
    expect(composeCron({ ...DEFAULT_SCHEDULE, time: "" })).toBe("0 9 * * *");
    expect(composeCron({ ...DEFAULT_SCHEDULE, time: "99:99" })).toBe(
      "0 9 * * *"
    );
  });

  // Editing must show the controls that produced the cron, not "Custom"
  // with a string the user never typed.
  it("round-trips every preset through decompose", () => {
    const drafts = [
      { ...DEFAULT_SCHEDULE, preset: "manual" as const },
      { ...DEFAULT_SCHEDULE, preset: "hourly" as const, time: "09:45" },
      { ...DEFAULT_SCHEDULE, preset: "daily" as const, time: "07:05" },
      { ...DEFAULT_SCHEDULE, preset: "weekdays" as const, time: "18:00" },
      {
        ...DEFAULT_SCHEDULE,
        preset: "weekly" as const,
        time: "10:00",
        weekday: 0 as const,
      },
    ];
    for (const draft of drafts) {
      const cron = composeCron(draft);
      expect(decomposeCron(cron)).toEqual(draft);
    }
  });

  it("keeps anything the presets cannot say as custom", () => {
    expect(decomposeCron("*/15 * * * *")).toEqual({
      ...DEFAULT_SCHEDULE,
      preset: "custom",
      custom: "*/15 * * * *",
    });
    expect(decomposeCron("0 9 1 * *").preset).toBe("custom");
    expect(decomposeCron("0 9 * * 1,3").preset).toBe("custom");
    expect(decomposeCron("0 9 * * 7").preset).toBe("custom");
  });

  it("reads null and blank as manual", () => {
    expect(decomposeCron(null).preset).toBe("manual");
    expect(decomposeCron("   ").preset).toBe("manual");
  });

  it("names weekdays and times in the UI language", () => {
    expect(weekdayName(1, "en-US")).toBe("Monday");
    expect(weekdayName(0, "fr-FR")).toBe("dimanche");
    expect(formatTime("17:30", "en-US")).toBe("5:30 PM");
    expect(formatTime("17:30", "de-DE")).toBe("17:30");
  });

  // A run-once time is an instant, not a cron: it survives the round trip
  // as the same local wall-clock minute and never becomes an expression.
  it("keeps a run-once time as an instant, apart from the cron", () => {
    const at = new Date(2026, 8, 3, 17, 58).getTime();
    expect(toLocalDateTime(at)).toBe("2026-09-03T17:58");
    expect(fromLocalDateTime("2026-09-03T17:58")).toBe(at);
    expect(fromLocalDateTime("")).toBeNull();

    const draft = decomposeSchedule(null, at);
    expect(draft.preset).toBe("once");
    expect(composeSchedule(draft)).toEqual({ schedule: null, runAt: at });
    expect(composeSchedule({ ...DEFAULT_SCHEDULE, preset: "daily" })).toEqual({
      schedule: "0 9 * * *",
      runAt: null,
    });
    expect(decomposeSchedule("0 9 * * *", null).preset).toBe("daily");
  });
});
