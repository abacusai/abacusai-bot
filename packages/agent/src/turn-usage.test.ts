import { describe, expect, it } from "vitest";

import { turnUsage } from "./turn-usage.js";

describe("turnUsage", () => {
  it("reports the last request of the turn, and how many there were", () => {
    const usage = turnUsage([
      { role: "user" },
      {
        role: "assistant",
        model: "m",
        usage: { input: 100, output: 5, cacheRead: 0, cacheWrite: 90 },
      },
      { role: "toolResult" },
      {
        role: "assistant",
        model: "m",
        usage: { input: 120, output: 40, cacheRead: 95, cacheWrite: 0 },
      },
    ]);
    expect(usage).toEqual({
      input: 120,
      output: 40,
      cacheRead: 95,
      cacheWrite: 0,
      requests: 2,
      model: "m",
    });
  });

  it("is null for a turn with no assistant message", () => {
    expect(turnUsage([{ role: "user" }])).toBeNull();
  });
});
