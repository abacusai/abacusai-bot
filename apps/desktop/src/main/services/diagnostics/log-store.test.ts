/**
 * Logs that outlive the run that wrote them.
 *
 * The reports this exists for are the ones nobody can press a button during:
 * an app that dies before its window opens, a renderer that took its own
 * buffer down with it, a user who quit yesterday and was asked for logs today.
 * So the cases here are about what is on disk afterwards, including what is
 * deliberately not: days past the window, and anything that looks like a key.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { dayKey, dayOfFile, LogStore, RETENTION_DAYS } from "./log-store";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "log-store-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const read = (name: string): string =>
  fs.readFileSync(path.join(dir, name), "utf8");
const names = (): string[] => fs.readdirSync(dir).sort();

const at = (iso: string) => () => new Date(iso);

describe("writing", () => {
  it("puts a line in the day's file for its stream", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.start();
    store.append("main", "[ERROR] spawn failed");
    store.flush();

    expect(names()).toEqual(["main-2026-08-21.log"]);
    expect(read("main-2026-08-21.log")).toContain("spawn failed");
  });

  it("keeps the streams apart, so one can be read without the others", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.start();
    store.append("main", "from main");
    store.append("renderer", "from renderer");
    store.append("agent", "from agent");
    store.flush();

    expect(names()).toEqual([
      "agent-2026-08-21.log",
      "main-2026-08-21.log",
      "renderer-2026-08-21.log",
    ]);
  });

  it("appends across flushes rather than starting the file over", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.start();
    store.append("main", "first");
    store.flush();
    store.append("main", "second");
    store.flush();

    const text = read("main-2026-08-21.log");

    expect(text).toContain("first");
    expect(text).toContain("second");
  });

  it("scrubs on the way in, since these files sit on disk for days", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.start();
    store.append("main", "OPENROUTER_API_KEY=sk-or-v1-abcdef123456");
    store.flush();

    expect(read("main-2026-08-21.log")).not.toContain("sk-or-v1-abcdef123456");
  });

  it("survives a directory it cannot write to", () => {
    const store = new LogStore(
      path.join(dir, "file-not-a-dir", "deeper"),
      at("2026-08-21T10:00:00")
    );

    fs.writeFileSync(path.join(dir, "file-not-a-dir"), "");

    expect(() => {
      store.start();
      store.append("main", "still running");
      store.flush();
    }).not.toThrow();
  });
});

describe("before the app starts it", () => {
  it("writes nothing: a unit test must not append to the real log directory", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.append("agent", "from some test's child process");
    store.flush();

    expect(names()).toEqual([]);
  });
});

describe("the retention window", () => {
  it(`keeps ${RETENTION_DAYS} days and deletes what is older`, () => {
    fs.writeFileSync(path.join(dir, "main-2026-08-21.log"), "today\n");
    fs.writeFileSync(path.join(dir, "main-2026-08-17.log"), "five days back\n");
    fs.writeFileSync(path.join(dir, "main-2026-08-16.log"), "six days back\n");
    fs.writeFileSync(path.join(dir, "agent-2026-07-01.log"), "ancient\n");

    new LogStore(dir, at("2026-08-21T10:00:00")).start();

    expect(names()).toEqual(["main-2026-08-17.log", "main-2026-08-21.log"]);
  });

  it("leaves anything that is not a log file alone", () => {
    fs.writeFileSync(path.join(dir, "notes.txt"), "someone else's file\n");

    new LogStore(dir, at("2026-08-21T10:00:00")).start();

    expect(names()).toContain("notes.txt");
  });

  it("rolls over at midnight, and prunes as it goes", () => {
    let now = new Date("2026-08-21T23:59:00");
    const store = new LogStore(dir, () => now);

    store.start();
    store.append("main", "late last night");
    now = new Date("2026-08-22T00:01:00");
    store.append("main", "early this morning");
    store.flush();

    // The first line belongs to the day it was written, not to the day the
    // flush happened to land on.
    expect(read("main-2026-08-21.log")).toContain("late last night");
    expect(read("main-2026-08-22.log")).toContain("early this morning");
  });
});

describe("reading them back", () => {
  it("lists the retained files oldest first, flushing what is still queued", () => {
    const store = new LogStore(dir, at("2026-08-21T10:00:00"));

    store.start();
    store.append("main", "not yet flushed");

    const files = store.files();

    expect(files.map((file) => file.name)).toEqual(["main-2026-08-21.log"]);
    expect(read("main-2026-08-21.log")).toContain("not yet flushed");
  });
});

describe("file names", () => {
  it("reads the day out of one, and refuses anything else", () => {
    expect(dayOfFile("agent-2026-08-21.log")).toBe("2026-08-21");
    expect(dayOfFile("notes.txt")).toBeNull();
    expect(dayOfFile("main-2026-08-21.log.bak")).toBeNull();
  });

  it("names the day in local time, which is the day a reader means", () => {
    expect(dayKey(new Date(2026, 7, 21, 23, 30))).toBe("2026-08-21");
  });
});
