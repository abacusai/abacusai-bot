/**
 * The bot's clock. The bar: a bot asked to prep an 8:30 call must never
 * answer "What time is it now?" — this tool is where that answer comes from.
 */
import { describe, expect, it } from "vitest";

import {
  buildBotTimeTool,
  describeNow,
  describeTimezone,
  timezonePrompt,
} from "./bot-time-tool.js";

describe("describeNow", () => {
  it("names the zone it answered in", () => {
    expect(describeNow("Asia/Kolkata")).toContain("Asia/Kolkata");
    expect(describeNow("America/New_York")).toContain("America/New_York");
  });

  it("defaults to the machine's own zone", () => {
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(describeNow()).toContain(zone);
  });

  it("reads as a date and a time, not an epoch", () => {
    const now = describeNow("UTC");
    expect(now).toMatch(/\d{4}/);
    expect(now).toMatch(/\d{1,2}:\d{2}/);
  });
});

describe("the current_time tool", () => {
  it("answers with the local time when called bare", async () => {
    const result = await buildBotTimeTool().execute("t1", {});
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toMatch(/\d{1,2}:\d{2}/);
  });

  it("answers in a requested timezone", async () => {
    const result = await buildBotTimeTool().execute("t2", {
      timezone: "Europe/Berlin",
    });
    expect(result.content[0]?.text).toContain("Europe/Berlin");
  });

  it("rejects a bad timezone with a usable hint", async () => {
    const result = await buildBotTimeTool().execute("t3", {
      timezone: "Mars/Olympus",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("IANA");
  });
});

describe("describeTimezone", () => {
  it("names the zone with its UTC offset", () => {
    expect(describeTimezone("Asia/Kolkata")).toBe(
      "Asia/Kolkata (GMT+5:30, UTC+05:30)"
    );
    expect(describeTimezone("America/New_York")).toMatch(
      /^America\/New_York \(E[SD]T, UTC-0[45]:00\)$/
    );
  });

  it('spells a zero offset out — a CI runner in UTC read "UTC (UTC, UTC)"', () => {
    expect(describeTimezone("UTC")).toBe("UTC (UTC, UTC+00:00)");
  });

  it("defaults to the machine's own zone", () => {
    expect(describeTimezone()).toContain(
      Intl.DateTimeFormat().resolvedOptions().timeZone
    );
  });
});

describe("timezonePrompt", () => {
  it("tells the model the zone, the clock, and to convert now", () => {
    const text = timezonePrompt();
    expect(text).toContain(Intl.DateTimeFormat().resolvedOptions().timeZone);
    // The zone, not the clock: a timestamp here would defeat prompt caching.
    expect(text).not.toMatch(/\d{4}/);
    expect(text).toMatch(/call `current_time`/);
    expect(text).toMatch(/in the user's local timezone/);
    expect(text).toMatch(/never promise to convert later/);
  });
});
