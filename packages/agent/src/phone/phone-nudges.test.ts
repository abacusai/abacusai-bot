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
  languageCode,
  phoneLanguage,
  phoneReplyLanguage,
  phoneZone,
  retireNudgedLoops,
  scriptLanguage,
  writePhoneLanguage,
  writePhoneReplyLanguage,
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
  it("keep a known IANA zone, refuse anything else, and forget it on null", () => {
    expect(phoneZone(dir)).toBeNull();
    expect(writePhoneZone(dir, "Asia/Kolkata")).toBe(true);
    expect(writePhoneZone(dir, "Asia/Kolkata")).toBe(false);
    expect(writePhoneZone(dir, "Mars/Olympus")).toBe(false);
    expect(phoneZone(dir)).toBe("Asia/Kolkata");
    expect(writePhoneZone(dir, null)).toBe(true);
    expect(phoneZone(dir)).toBeNull();
  });

  it("keep a language code the server takes, never free text, and forget it on null", () => {
    expect(phoneLanguage(dir)).toBeNull();
    writePhoneLanguage(dir, "Spanish please");
    expect(phoneLanguage(dir)).toBeNull();
    writePhoneLanguage(dir, "pt-BR");
    expect(phoneLanguage(dir)).toBe("pt-BR");
    writePhoneLanguage(dir, null);
    expect(phoneLanguage(dir)).toBeNull();
  });

  it("keep the user's language apart from the check-in language, and forget it on null", () => {
    expect(phoneReplyLanguage(dir)).toBeNull();
    expect(writePhoneReplyLanguage(dir, "es")).toBe(true);
    expect(writePhoneReplyLanguage(dir, "es")).toBe(false);
    expect(writePhoneReplyLanguage(dir, "Spanish")).toBe(false);
    expect(phoneReplyLanguage(dir)).toBe("es");
    expect(phoneLanguage(dir)).toBeNull();
    expect(writePhoneReplyLanguage(dir, null)).toBe(true);
    expect(phoneReplyLanguage(dir)).toBeNull();
  });

  it("trim a model's code to the server's shape: a primary tag and one subtag", () => {
    expect(languageCode("ES")).toBe("es");
    expect(languageCode("pt_BR")).toBe("pt-BR");
    expect(languageCode("zh-Hant-TW")).toBe("zh-Hant");
    expect(languageCode("Spanish")).toBeNull();
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
  });

  it("never reads a wall time as UTC when no zone is known", () => {
    expect(dueWindow("2026-10-09T10:30", null)).toBeNull();
    expect(dueWindow("2026-10-09", null)).toBeNull();
    expect(dueWindow("2026-10-09T10:30+05:30", null)).toEqual({
      at: Date.parse("2026-10-09T05:00:00Z"),
      endOfDay: Date.parse("2026-10-09T18:29:00Z"),
    });
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

  it("lists open loops due today to a week out, soonest first, with only their words (`at` says when)", () => {
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
      summary: "Call the bank about fees",
    });
  });

  it("keeps a summary within the server's limit", () => {
    writeJson(phonePaths(dir).loops, [
      { id: "L1", text: "x".repeat(400), due: "2026-10-09", status: "open" },
    ]);
    const [item] = dueAgendaItems(dir, now, "UTC");
    expect(item!.summary.length).toBeLessThanOrEqual(200);
  });

  it("is empty with no loops file, and lists only loops with an offset when no zone is known", () => {
    expect(dueAgendaItems(dir, now, "UTC")).toEqual([]);
    writeJson(phonePaths(dir).loops, [
      { id: "L1", text: "Wall time", due: "2026-10-09T10:30", status: "open" },
      {
        id: "L2",
        text: "Instant",
        due: "2026-10-09T10:30+05:30",
        status: "open",
      },
    ]);
    expect(dueAgendaItems(dir, now, null).map((item) => item.item_id)).toEqual([
      "loop:L2",
    ]);
  });

  it("drops a loop once a check-in went after it was due, until its due moves", () => {
    writeJson(phonePaths(dir).loops, [
      {
        id: "L1",
        text: "Morning call",
        due: "2026-10-09T09:00",
        status: "open",
      },
      {
        id: "L2",
        text: "Evening call",
        due: "2026-10-09T19:00",
        status: "open",
      },
    ]);
    const zone = "Asia/Kolkata";
    const sentAt = Date.parse("2026-10-09T04:00:00Z") / 1000; // 09:30 local
    expect(retireNudgedLoops(dir, [sentAt], zone)).toBe(true);
    expect(retireNudgedLoops(dir, [sentAt], zone)).toBe(false);
    expect(dueAgendaItems(dir, now, zone).map((item) => item.item_id)).toEqual([
      "loop:L2",
    ]);
    writeJson(phonePaths(dir).loops, [
      {
        id: "L1",
        text: "Morning call",
        due: "2026-10-10T09:00",
        status: "open",
      },
    ]);
    expect(dueAgendaItems(dir, now, zone).map((item) => item.item_id)).toEqual([
      "loop:L1",
    ]);
  });
});

describe("scriptLanguage", () => {
  it("names a language only where the script names one", () => {
    expect(scriptLanguage("안녕하세요 반갑습니다")).toBe("ko");
    expect(scriptLanguage("明日の会議は何時ですか")).toBe("ja");
    expect(scriptLanguage("สวัสดีครับ ขอบคุณ")).toBe("th");
    expect(scriptLanguage("Καλημέρα σας")).toBe("el");
    expect(scriptLanguage("שלום מה שלומך")).toBe("he");
    expect(scriptLanguage("明天的会议几点")).toBeNull();
    expect(scriptLanguage("Hola, ¿qué tal?")).toBeNull();
    expect(scriptLanguage("Привет, как дела")).toBeNull();
    expect(scriptLanguage("ok")).toBeNull();
  });
});
