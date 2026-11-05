import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { describe, expect, it } from "vitest";

import { flaggedDuplicates } from "./duplicates";

const row = (id: string, over: Partial<RoutineRow> = {}): RoutineRow =>
  ({
    id,
    name: "Morning brief",
    prompt: "Summarize my inbox for today.",
    schedule: "0 8 * * *",
    runAt: null,
    botId: "bot-1",
    enabled: true,
    webhookToken: null,
    webhookUrl: null,
    ...over,
  }) as RoutineRow;

describe("flaggedDuplicates", () => {
  it("flags both sides of a pair until the user keeps it", () => {
    const rows = [row("a"), row("b"), row("c", { schedule: "0 9 * * *" })];
    expect([...flaggedDuplicates(rows, []).keys()]).toEqual(["a", "b"]);
    expect(flaggedDuplicates(rows, ["a|b"]).size).toBe(0);
  });

  it("reads a hosted row's zone: the same cron in two zones is two times", () => {
    const zone = (id: string, timezone: string) =>
      row(id, { hosted: { timezone } as RoutineRow["hosted"] });
    expect(
      flaggedDuplicates([zone("a", "UTC"), zone("b", "Asia/Kolkata")], []).size
    ).toBe(0);
  });
});
