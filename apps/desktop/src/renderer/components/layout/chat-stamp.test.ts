/**
 * How a chat list stamps its rows.
 *
 * The vocabulary a phone's message list uses, and the one a bot's row wants:
 * the clock time while it is still today, and the day once it is not. The
 * compact ages the workspace tree draws ("17m", "54d") answer a different
 * question: how stale is this, rather than when was this said.
 */
import { describe, expect, it } from "vitest";

import { chatStamp } from "./session-list-utils";

const NOW = new Date("2026-08-28T14:00:00").getTime();
const at = (iso: string): number => new Date(iso).getTime();

describe("chatStamp", () => {
  it("gives the clock time for anything said today", () => {
    expect(chatStamp(at("2026-08-28T13:25:00"), NOW)?.kind).toBe("time");
    // Midnight is today, not yesterday: the boundary is the start of the day,
    // not 24 hours ago.
    expect(chatStamp(at("2026-08-28T00:00:00"), NOW)?.kind).toBe("time");
  });

  it("names yesterday rather than counting hours back", () => {
    // 14 hours ago, but a different day: "Yesterday" is what a reader wants,
    // not "14h".
    expect(chatStamp(at("2026-08-27T23:59:00"), NOW)?.kind).toBe("yesterday");
    expect(chatStamp(at("2026-08-27T00:00:00"), NOW)?.kind).toBe("yesterday");
  });

  it("uses the weekday for the rest of the week", () => {
    expect(chatStamp(at("2026-08-26T09:00:00"), NOW)?.kind).toBe("weekday");
    expect(chatStamp(at("2026-08-22T09:00:00"), NOW)?.kind).toBe("weekday");
  });

  it("falls back to a date once the weekday stops meaning one week", () => {
    // "last Tuesday" is ambiguous the moment two Tuesdays could be meant.
    expect(chatStamp(at("2026-08-21T09:00:00"), NOW)?.kind).toBe("date");
  });

  it("says whether a date needs its year", () => {
    const thisYear = chatStamp(at("2026-01-05T09:00:00"), NOW);
    const lastYear = chatStamp(at("2025-12-30T09:00:00"), NOW);

    expect(thisYear).toEqual({ kind: "date", sameYear: true });
    expect(lastYear).toEqual({ kind: "date", sameYear: false });
  });

  it("says nothing when there is no time to show", () => {
    // A transcript written before times were kept. A stamp invented for it
    // would be a claim about when work happened that nobody can back.
    expect(chatStamp(null, NOW)).toBeNull();
    expect(chatStamp(undefined, NOW)).toBeNull();
    expect(chatStamp(0, NOW)).toBeNull();
    expect(chatStamp(Number.NaN, NOW)).toBeNull();
  });

  it("treats a clock that ran ahead as today, not as the future", () => {
    expect(chatStamp(at("2026-08-28T23:00:00"), NOW)?.kind).toBe("time");
  });
});
