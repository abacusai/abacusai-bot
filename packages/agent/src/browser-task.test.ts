import { describe, expect, it } from "vitest";

import {
  MAX_TURNS,
  missingReportFields,
  needsUser,
  REPEAT_HOST_LIMIT,
  RepeatTracker,
  WRAP_UP_TURN,
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
    expect(WRAP_UP_TURN).toBeLessThan(MAX_TURNS);
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
});
