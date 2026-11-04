import { describe, expect, it } from "vitest";

import { addRunUsage, turnUsage } from "./turn-usage.js";

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
      total: { input: 220, output: 45, cacheRead: 95, cacheWrite: 90 },
    });
  });

  it("adds every run of a turn up, and keeps the last request", () => {
    const run = (input: number) =>
      turnUsage([
        {
          role: "assistant",
          model: "m",
          usage: { input, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
        {
          role: "assistant",
          model: "m",
          usage: { input: input + 1, output: 1, cacheRead: 0, cacheWrite: 0 },
        },
      ]);
    const turn = addRunUsage(run(100), run(200));
    expect(turn?.input).toBe(201);
    expect(turn?.requests).toBe(2);
    expect(turn?.total?.input).toBe(602);
    expect(addRunUsage(null, run(100))?.total?.input).toBe(201);
    expect(addRunUsage(run(100), null)?.total?.input).toBe(201);
  });

  it("is null for a turn with no assistant message", () => {
    expect(turnUsage([{ role: "user" }])).toBeNull();
  });
});
