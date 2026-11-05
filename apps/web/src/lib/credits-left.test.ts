/** The balance shown after a turn: an upper bound that only falls within a grant. */
import { describe, expect, it } from "vitest";

import { foldRead, foldTurn, leftAfter } from "./credits-left";

const read = (used: number, at: number, granted = 2000, account = "o:u") => ({
  account,
  granted,
  used,
  at,
});

describe("credits left", () => {
  it.each([
    ["the first read is taken as is", [read(100, 10)], 1900],
    ["a later, lower read wins", [read(100, 10), read(130, 20)], 1870],
    [
      "a read that trails the spend never raises it",
      [read(130, 10), read(120, 20)],
      1870,
    ],
    [
      "an older read arriving late is ignored",
      [read(130, 20), read(100, 10)],
      1870,
    ],
    ["a new grant starts over", [read(1900, 10), read(0, 20, 5000)], 5000],
    ["a new period starts over", [read(1900, 10), read(40, 20)], 1960],
    [
      "another account starts over",
      [read(1900, 10), read(10, 20, 2000, "o:v")],
      1990,
    ],
    ["spent past the grant reads zero", [read(2100, 10)], 0],
  ])("%s", (_name, reads, left) => {
    const ceiling = reads.reduce(foldRead, null as never);
    expect(ceiling.left).toBe(left);
  });

  it("takes a turn off a read from before it, once, and shows it before the next read", () => {
    const before = foldRead(null, read(100, 10));
    const turn = { runId: "r1", startedAt: 20, endedAt: 30, credits: 18 };
    const after = foldTurn(foldTurn(before, turn), turn);
    expect(after?.left).toBe(1882);
    expect(leftAfter(after, "o:u", turn)).toBe(1882);
    // The read after the turn that still trails it cannot raise the balance.
    expect(foldRead(after, read(100, 40)).left).toBe(1882);
  });

  it("waits for a read after the turn when the last one came during it", () => {
    const during = foldRead(null, read(105, 25));
    const turn = { runId: "r1", startedAt: 20, endedAt: 30, credits: 18 };
    const ceiling = foldTurn(during, turn);
    expect(ceiling?.left).toBe(1895);
    expect(leftAfter(ceiling, "o:u", turn)).toBeNull();
    expect(leftAfter(foldRead(ceiling, read(118, 40)), "o:u", turn)).toBe(1882);
  });

  it("knows nothing for another account", () => {
    const ceiling = foldRead(null, read(100, 40));
    expect(leftAfter(ceiling, "o:v", { runId: "r1", endedAt: 30 })).toBeNull();
    expect(leftAfter(null, "o:u", { runId: "r1", endedAt: 30 })).toBeNull();
  });
});
