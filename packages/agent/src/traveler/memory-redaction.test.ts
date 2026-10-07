/**
 * ID numbers never reach free-text memory: every writer, phone and bot,
 * withholds them, whatever turn or tool asked it to write.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { botDailyNoteFile } from "../bot/bot-config.js";
import {
  addCoreEntry,
  appendDailyNote,
  readCoreEntries,
} from "../bot/bot-memory.js";
import { phonePaths } from "../phone/phone-config.js";
import {
  aboutYouEntries,
  appendLog,
  readLogLines,
  readLoops,
  readNote,
  rememberFact,
  stageStory,
  trackLoop,
  writeTopicNote,
} from "../phone/phone-memory.js";
import { ID_NUMBER_WITHHELD } from "./id-numbers.js";

const PASSPORT = "K1234567";
const ID = `passport number is ${PASSPORT}`;

let dir: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "memory-redaction-"));
  process.env.ABACUSAI_BOT_HOME = dir;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("the phone's memory writers", () => {
  it("withhold ID numbers in about-you, loops, the log, notes and the story", async () => {
    const now = new Date();
    await rememberFact(`Asha's ${ID}`);
    trackLoop(dir, { text: `Renew passport ${PASSPORT}` }, now);
    appendLog(dir, "2026-10-07", [`Booked a flight; ${ID}`]);
    writeTopicNote(dir, { topic: "Trip", text: `Traveler ${ID}` });
    stageStory(dir, `They gave the ${ID}.`);

    const written = [
      ...aboutYouEntries(),
      ...readLoops(dir).map((loop) => loop.text),
      ...readLogLines(dir, "2026-10-07"),
      readNote(dir, "trip")?.body ?? "",
      fs.readFileSync(phonePaths(dir).nextSummary, "utf8"),
    ];
    expect(written).toHaveLength(5);
    for (const text of written) {
      expect(text).not.toContain(PASSPORT);
      expect(text).toContain(ID_NUMBER_WITHHELD);
    }
  });
});

describe("a bot's memory writers", () => {
  it("withhold ID numbers in core memory and the daily notes", () => {
    addCoreEntry(dir, `Owner's ${ID}`);
    appendDailyNote(dir, `Used ${ID} for the booking`);
    const written = [
      ...readCoreEntries(dir),
      fs.readFileSync(botDailyNoteFile(dir), "utf8"),
    ];
    for (const text of written) {
      expect(text).not.toContain(PASSPORT);
      expect(text).toContain(ID_NUMBER_WITHHELD);
    }
  });
});
