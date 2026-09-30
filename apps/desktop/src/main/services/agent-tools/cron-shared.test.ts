/**
 * R5-T9 (main side): the parser moved to `shared/`; main's scheduler uses the
 * same functions through `cron-store`'s re-export, and a parse failure is a
 * typed `CronParseError` whose name and message are what legacy IPC saw.
 */
import { describe, expect, it } from "vitest";

import { CronParseError, nextRun, parseCron } from "#shared/routines/cron";
import { TimeoutError } from "#shared/timeout-error";

import * as store from "./cron-store";

describe("shared cron parser", () => {
  it("is the one main re-exports", () => {
    expect(store.parseCron).toBe(parseCron);
    expect(store.nextRun).toBe(nextRun);
    expect(store.CronParseError).toBe(CronParseError);
  });

  it("computes the next fire as main always did", () => {
    const from = new Date(2026, 0, 5, 8, 30); // a Monday
    expect(nextRun("0 9 * * 1-5", from)?.getTime()).toBe(
      new Date(2026, 0, 5, 9, 0).getTime()
    );
    expect(nextRun("*/15 * * * *", from)?.getTime()).toBe(
      new Date(2026, 0, 5, 8, 45).getTime()
    );
    expect(nextRun("30 2 30 2 *", from)).toBeNull();
    // 7 is Sunday.
    expect(parseCron("0 0 * * 7").dayOfWeek.values.has(0)).toBe(true);
  });

  it.each([
    [
      "0 0 9 * * 1",
      "Six-field expressions (with seconds) are not supported. Use five fields: minute hour day month weekday.",
    ],
    ["0 9 * *", "Expected five fields (minute hour day month weekday), got 4."],
    [
      "0 9 * * MON",
      "Names like MON or JAN are not supported. Use numbers: 0-6 for weekday, 1-12 for month.",
    ],
    ["*/0 * * * *", 'Bad step "0" in the minute field.'],
    ["1-? * * * *", 'Bad range "1-?" in the minute field.'],
    ["61 * * * *", 'The minute field must be between 0 and 59; got "61".'],
  ])("%s is a typed error with the legacy message", (expression, message) => {
    let thrown: unknown;
    try {
      parseCron(expression);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(CronParseError);
    expect((thrown as CronParseError).message).toBe(message);
    expect((thrown as CronParseError).detail).toBe(message);
    // Legacy IPC serialises `${error}`: still "Error: <message>".
    expect(String(thrown)).toBe(`Error: ${message}`);
  });

  it("TimeoutError keeps the plain Error name too", () => {
    const error = new TimeoutError("The routine did not answer in time.", 5);
    expect(String(error)).toBe("Error: The routine did not answer in time.");
    expect(error.ms).toBe(5);
  });
});
