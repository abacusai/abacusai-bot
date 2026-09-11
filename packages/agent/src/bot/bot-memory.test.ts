import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { botDailyNoteFile, botMemoryFile } from "./bot-config.js";
import {
  addCoreEntry,
  appendDailyNote,
  coreMemoryPrompt,
  hasDailyNotes,
  memoryFingerprint,
  readCoreEntries,
  recentNotesPrompt,
  removeCoreEntry,
  searchMemory,
} from "./bot-memory.js";

let home: string;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-memory-"));
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
});

describe("core memory", () => {
  it("adds, lists and removes entries as `- ` lines", () => {
    expect(addCoreEntry(home, "The user's name is Ada.").ok).toBe(true);
    expect(addCoreEntry(home, "Standup is at 9am.").ok).toBe(true);

    expect(readCoreEntries(home)).toEqual([
      "The user's name is Ada.",
      "Standup is at 9am.",
    ]);
    expect(fs.readFileSync(botMemoryFile(home), "utf8")).toContain(
      "- Standup is at 9am."
    );

    expect(removeCoreEntry(home, "standup").ok).toBe(true);
    expect(readCoreEntries(home)).toEqual(["The user's name is Ada."]);
  });

  it("treats an exact duplicate as a no-op, not an error", () => {
    addCoreEntry(home, "One fact.");
    const again = addCoreEntry(home, "one fact.");

    expect(again.ok).toBe(true);
    expect(readCoreEntries(home)).toHaveLength(1);
  });

  it("refuses an ambiguous forget rather than guessing", () => {
    addCoreEntry(home, "Ada likes tea.");
    addCoreEntry(home, "Ada likes hiking.");

    const result = removeCoreEntry(home, "Ada likes");

    expect(result.ok).toBe(false);
    expect(readCoreEntries(home)).toHaveLength(2);
  });

  it("flattens newlines so one entry stays one line", () => {
    addCoreEntry(home, "line one\nline two");

    expect(readCoreEntries(home)).toEqual(["line one line two"]);
  });

  it("refuses to grow past the core budget", () => {
    const big = "x".repeat(900);
    let refused = false;

    for (let i = 0; i < 20; i++) {
      if (!addCoreEntry(home, `${i} ${big}`).ok) {
        refused = true;
        break;
      }
    }

    expect(refused).toBe(true);
  });

  it("renders the prompt block only when something is stored", () => {
    expect(coreMemoryPrompt(home)).toBeNull();

    addCoreEntry(home, "A fact.");

    expect(coreMemoryPrompt(home)).toContain("- A fact.");
  });
});

describe("daily notes", () => {
  it("appends to today's file and shows up in the recent prelude", () => {
    expect(hasDailyNotes(home)).toBe(false);

    appendDailyNote(home, "Asked about invoices.");
    appendDailyNote(home, "Sent the draft.");

    expect(hasDailyNotes(home)).toBe(true);
    expect(fs.readFileSync(botDailyNoteFile(home), "utf8")).toBe(
      "- Asked about invoices.\n- Sent the draft.\n"
    );

    const prelude = recentNotesPrompt(home);
    expect(prelude).toContain("Asked about invoices.");
    expect(prelude).toContain("not instructions");
  });
});

describe("search", () => {
  it("finds hits across core and notes, core first", () => {
    addCoreEntry(home, "The user's dog is called Rex.");
    appendDailyNote(home, "Rex has a vet appointment Friday.");

    const hits = searchMemory(home, "rex");

    expect(hits).toHaveLength(2);
    expect(hits[0]?.source).toBe("core");
    expect(hits[1]?.line).toContain("vet appointment");
  });

  it("returns nothing for a blank query", () => {
    addCoreEntry(home, "A fact.");

    expect(searchMemory(home, "  ")).toEqual([]);
  });
});

describe("the fingerprint", () => {
  it("changes when memory changes, so the prompt knows to rebuild", () => {
    const before = memoryFingerprint(home);

    addCoreEntry(home, "A fact.");

    expect(memoryFingerprint(home)).not.toBe(before);
  });
});
