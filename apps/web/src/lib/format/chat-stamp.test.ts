/**
 * How a chat list stamps its rows.
 *
 * The vocabulary a phone's message list uses, and the one a bot's row wants:
 * the clock time while it is still today, and the day once it is not. The
 * compact ages the workspace tree draws ("17m", "54d") answer a different
 * question: how stale is this, rather than when was this said.
 *
 * Ported from the old renderer's layout/chat-stamp.test.ts (spec 03 P17).
 */
import { describe, expect, it } from "vitest";

import { chatStamp, formatChatStamp } from "./chat-stamp";

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

describe("formatChatStamp", () => {
  it("words each kind as the old bots tree did", () => {
    expect(
      formatChatStamp(at("2026-08-28T13:25:00"), NOW, "en-US", "Yesterday")
    ).toBe("1:25 PM");
    expect(
      formatChatStamp(at("2026-08-27T09:00:00"), NOW, "en-US", "Yesterday")
    ).toBe("Yesterday");
    expect(
      formatChatStamp(at("2026-08-26T09:00:00"), NOW, "en-US", "Yesterday")
    ).toBe("Wednesday");
    expect(
      formatChatStamp(at("2026-01-05T09:00:00"), NOW, "en-US", "Yesterday")
    ).toBe("Jan 5");
    expect(
      formatChatStamp(at("2025-12-30T09:00:00"), NOW, "en-US", "Yesterday")
    ).toBe("Dec 30, 2025");
    expect(formatChatStamp(null, NOW, "en-US", "Yesterday")).toBeNull();
  });
});

it("matches fresh local formatters after zone changes, through DST, and across locales", () => {
  const env = (globalThis as unknown as { process: { env: { TZ?: string } } })
    .process.env;
  const original = env.TZ;
  try {
    for (const zone of [
      "UTC",
      "America/New_York",
      "Asia/Kolkata",
      "Africa/Monrovia",
    ]) {
      env.TZ = zone;
      for (const language of ["en-US", "de-DE", "ar-EG", "th-TH"]) {
        for (const instant of [
          "2026-03-08T06:59:00Z",
          "2026-03-08T07:01:00Z",
          "2026-11-01T05:30:00Z",
          "2026-11-01T06:30:00Z",
          "1971-01-01T00:44:45Z",
        ]) {
          const when = new Date(instant);
          expect(
            formatChatStamp(
              when.getTime(),
              when.getTime(),
              language,
              "Yesterday"
            )
          ).toBe(
            when.toLocaleTimeString(language, {
              hour: "numeric",
              minute: "2-digit",
            })
          );
          const now = new Date(when);
          now.setDate(now.getDate() + 3);
          expect(
            formatChatStamp(
              when.getTime(),
              now.getTime(),
              language,
              "Yesterday"
            )
          ).toBe(
            new Intl.DateTimeFormat(language, { weekday: "long" }).format(when)
          );
          now.setFullYear(now.getFullYear() + 1);
          expect(
            formatChatStamp(
              when.getTime(),
              now.getTime(),
              language,
              "Yesterday"
            )
          ).toBe(
            new Intl.DateTimeFormat(language, {
              month: "short",
              day: "numeric",
              year: "numeric",
            }).format(when)
          );
        }
      }
    }
  } finally {
    if (original === undefined) delete env.TZ;
    else env.TZ = original;
  }
});
