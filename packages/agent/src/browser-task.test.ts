import { describe, expect, it } from "vitest";

import {
  budgetNote,
  EXECUTE_STREAK_LIMIT,
  ExecuteStreakTracker,
  FINAL_WARNING_TURN,
  finalWarningMessage,
  MAX_TURNS,
  missingReportFields,
  needsUser,
  REPEAT_HOST_LIMIT,
  RepeatTracker,
  WRAP_UP_TURN,
  wrapUpMessage,
} from "./browser-task.js";

describe("checking a browser report against what was asked for", () => {
  it("accepts a field the report names outright", () => {
    expect(
      missingReportFields("Cheapest: ₹8,240 on IndiGo, price includes bags", [
        "price",
        "airline",
      ])
    ).toEqual(["airline"]);
  });

  it("accepts a word-stem match, so 'departs at 06:10' covers 'departure time'", () => {
    expect(
      missingReportFields("Flight 6E 204 departs at 06:10, lands 08:55", [
        "departure time",
      ])
    ).toEqual([]);
  });

  it("names every field the report skipped", () => {
    expect(
      missingReportFields("I found some results.", ["price", "URL", "airline"])
    ).toEqual(["price", "URL", "airline"]);
  });

  it("ignores blank fields", () => {
    expect(missingReportFields("anything", ["", "  "])).toEqual([]);
  });

  it("ignores field names that ask for nothing in particular", () => {
    expect(
      missingReportFields("Cheapest is ₹52,142.", ["status", "result", "price"])
    ).toEqual(["price"]);
  });

  it("is case-insensitive", () => {
    expect(missingReportFields("URL: https://a.test", ["url"])).toEqual([]);
  });
});

describe("the run bounds", () => {
  it("asks for the report before the hard turn ceiling", () => {
    expect(WRAP_UP_TURN).toBeLessThan(FINAL_WARNING_TURN);
    expect(FINAL_WARNING_TURN).toBeLessThan(MAX_TURNS);
  });

  it("tells the run how many turns it has, not that it is 'close to a limit'", () => {
    // "close to your limit" reads as "out of budget" to a small model; it then
    // reports at once, and a resumed run reports before it does anything.
    expect(wrapUpMessage(40)).toMatch(/40 turns/);
    expect(wrapUpMessage(40)).not.toMatch(/close to/i);
    expect(finalWarningMessage(15)).toMatch(/15 turns/);
    expect(budgetNote(MAX_TURNS)).toMatch(
      new RegExp(`${MAX_TURNS} tool turns`)
    );
  });
});

describe("noticing a run scraping by hand", () => {
  it("fires when browser_execute runs the limit times in a row", () => {
    const tracker = new ExecuteStreakTracker(3);

    expect(tracker.observe("browser_execute")).toBe(false);
    expect(tracker.observe("browser_execute")).toBe(false);
    expect(tracker.observe("browser_execute")).toBe(true);
    expect(tracker.observe("browser_execute")).toBe(false);
    expect(tracker.total).toBe(4);
  });

  it("starts over once any page tool is used", () => {
    const tracker = new ExecuteStreakTracker(2);

    tracker.observe("browser_execute");
    tracker.observe("browser_snapshot");
    expect(tracker.observe("browser_execute")).toBe(false);
    expect(tracker.observe("browser_execute")).toBe(true);
  });

  it("allows the odd script for what the page tools cannot reach", () => {
    expect(EXECUTE_STREAK_LIMIT).toBeGreaterThanOrEqual(4);
  });
});

describe("noticing a run going in circles", () => {
  const goto = (url: string): [string, unknown] => [
    "browser_navigate",
    { action: "goto", url },
  ];

  it("fires once when one host is loaded the limit times in a row", () => {
    const tracker = new RepeatTracker(3);

    expect(tracker.observe(...goto("https://www.google.com/search?q=a"))).toBe(
      false
    );
    expect(tracker.observe("browser_snapshot", { action: "text" })).toBe(false);
    expect(tracker.observe(...goto("https://www.google.com/search?q=b"))).toBe(
      false
    );
    expect(tracker.observe(...goto("https://www.google.com/search?q=c"))).toBe(
      true
    );
    expect(tracker.observe(...goto("https://www.google.com/search?q=d"))).toBe(
      false
    );
  });

  it("starts over when a different host is loaded", () => {
    const tracker = new RepeatTracker(2);

    tracker.observe(...goto("https://a.test/"));
    tracker.observe(...goto("https://b.test/"));

    expect(tracker.observe(...goto("https://b.test/x"))).toBe(true);
  });

  it("treats acting on a page as progress, but not waiting or scrolling", () => {
    const tracker = new RepeatTracker(2);

    tracker.observe(...goto("https://a.test/"));
    tracker.observe("browser_interact", {
      action: "scroll",
      direction: "down",
    });
    tracker.observe("browser_interact", { action: "wait", text: "x" });
    expect(tracker.observe(...goto("https://a.test/2"))).toBe(true);

    tracker.observe("browser_interact", { action: "click", ref: "@e1" });
    expect(tracker.observe(...goto("https://a.test/3"))).toBe(false);
  });

  it("has a limit that leaves room for a real multi-page task", () => {
    expect(REPEAT_HOST_LIMIT).toBeGreaterThanOrEqual(5);
  });
});

describe("a run that stopped for the user", () => {
  it("is recognised by its NEEDS USER line, wherever the model put it", () => {
    expect(
      needsUser(
        "Fare found: ₹52,142.\n\nNEEDS USER: enter card details and press Pay."
      )
    ).toBe(true);
    expect(
      needsUser("**NEEDS USER:** sign in to LinkedIn, then tell me.")
    ).toBe(true);
    expect(needsUser("The user needs to know the price is ₹52,142.")).toBe(
      false
    );
  });

  it("is not a NEEDS USER line that says nothing is needed", () => {
    // Models write the line to say they were not blocked. Read as a stop, it
    // parks the run and sends the user to the browser to do nothing.
    for (const report of [
      "Found 3 fares.\n\nNEEDS USER: none — the site rendered fine.",
      "NEEDS USER: none required to continue; no login or CAPTCHA was hit.",
      "NEEDS USER: nothing to hand over — no sign-in or payment was reached.",
      "**NEEDS USER:** N/A",
      "NEEDS USER: no action needed.",
      "NEEDS USER:",
      "NEEDS USER: -",
    ]) {
      expect(needsUser(report), report).toBe(false);
    }
  });

  it("still stops for a real step, however it is phrased", () => {
    for (const report of [
      "NEEDS USER: sign in to LinkedIn, then tell me.",
      "NEEDS USER: enter the card details and press Pay.",
      "NEEDS USER: solve the CAPTCHA on the page.",
      "NEEDS USER: No fares load until you sign in — sign in, then tell me.",
    ]) {
      expect(needsUser(report), report).toBe(true);
    }
  });
});
