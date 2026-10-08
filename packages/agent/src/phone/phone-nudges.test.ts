/**
 * The phone loop's side of check-ins: the zone and language files the
 * hosted app and the loop share, and loops due soon as agenda items that
 * carry the loop's words and its due time, nothing else.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { phonePaths, writeJson } from "./phone-config.js";
import {
  dueAgendaItems,
  dueWindow,
  phoneLanguage,
  phoneZone,
  writePhoneLanguage,
  writePhoneZone,
  zonedWallTime,
} from "./phone-nudges.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "phone-nudges-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the zone and language files", () => {
  it("keep a known IANA zone and refuse anything else", () => {
    expect(phoneZone(dir)).toBeNull();
    expect(writePhoneZone(dir, "Asia/Kolkata")).toBe(true);
    expect(writePhoneZone(dir, "Asia/Kolkata")).toBe(false);
    expect(writePhoneZone(dir, "Mars/Olympus")).toBe(false);
    expect(phoneZone(dir)).toBe("Asia/Kolkata");
  });

  it("keep a language code, never free text", () => {
    expect(phoneLanguage(dir)).toBeNull();
    writePhoneLanguage(dir, "Spanish please");
    expect(phoneLanguage(dir)).toBeNull();
    writePhoneLanguage(dir, "pt-BR");
    expect(phoneLanguage(dir)).toBe("pt-BR");
  });
});

describe("dueWindow", () => {
  it("takes a time with an offset as that instant", () => {
    const window = dueWindow("2026-10-09T10:30+05:30", "America/New_York");
    expect(window?.at).toBe(Date.parse("2026-10-09T05:00:00Z"));
  });

  it("reads a time without an offset on the user's wall clock", () => {
    expect(dueWindow("2026-10-09T10:30", "Asia/Kolkata")?.at).toBe(
      Date.parse("2026-10-09T05:00:00Z")
    );
    expect(dueWindow("2026-10-09T10:30", null)?.at).toBe(
      Date.parse("2026-10-09T10:30:00Z")
    );
  });

  it("puts a date alone at ten in the morning, and ends the day at 23:59 local", () => {
    const window = dueWindow("2026-10-09", "Europe/Madrid");
    expect(window?.at).toBe(Date.parse("2026-10-09T08:00:00Z"));
    expect(window?.endOfDay).toBe(Date.parse("2026-10-09T21:59:00Z"));
  });

  it("holds across a DST change", () => {
    // New York moves from EDT to EST on 2026-11-01.
    expect(
      zonedWallTime({ y: 2026, m: 11, d: 2, hh: 9, mm: 0 }, "America/New_York")
    ).toBe(Date.parse("2026-11-02T14:00:00Z"));
  });

  it("refuses what is not an ISO date", () => {
    expect(dueWindow("next Friday", "UTC")).toBeNull();
  });
});

describe("dueAgendaItems", () => {
  const now = Date.parse("2026-10-09T06:00:00Z");

  it("lists open loops due today to a week out, soonest first, with only their words and due time", () => {
    writeJson(phonePaths(dir).loops, [
      { id: "L1", text: "Renew passport", due: "2026-10-10", status: "open" },
      {
        id: "L2",
        text: "Call the  bank\nabout fees",
        due: "2026-10-09T10:30",
        status: "open",
      },
      { id: "L3", text: "Done already", due: "2026-10-09", status: "done" },
      { id: "L4", text: "No date", status: "open" },
      { id: "L5", text: "Yesterday", due: "2026-10-08", status: "open" },
      { id: "L6", text: "Far out", due: "2026-10-30", status: "open" },
    ]);
    const items = dueAgendaItems(dir, now, "Asia/Kolkata");
    expect(items.map((item) => item.item_id)).toEqual(["loop:L2", "loop:L1"]);
    expect(items[0]).toEqual({
      item_id: "loop:L2",
      kind: "due",
      at: Date.parse("2026-10-09T05:00:00Z") / 1000,
      expires_at: Date.parse("2026-10-09T18:29:00Z") / 1000,
      summary: "Call the bank about fees (due 2026-10-09T10:30)",
    });
  });

  it("keeps a summary within the server's limit", () => {
    writeJson(phonePaths(dir).loops, [
      { id: "L1", text: "x".repeat(400), due: "2026-10-09", status: "open" },
    ]);
    const [item] = dueAgendaItems(dir, now, null);
    expect(item!.summary.length).toBeLessThanOrEqual(200);
    expect(item!.summary).toMatch(/\(due 2026-10-09\)$/);
  });

  it("is empty with no loops file", () => {
    expect(dueAgendaItems(dir, now, null)).toEqual([]);
  });
});
