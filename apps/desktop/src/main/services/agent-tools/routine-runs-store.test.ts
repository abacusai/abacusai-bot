import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  countRoutineRuns,
  readLastRoutineRun,
  recordRoutineRun,
  removeRoutineDir,
  routineDir,
  routineDirInWorkspace,
  routineNotes,
  routineRunsDir,
} from "./routine-runs-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "routine-runs-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("a routine's folder", () => {
  it("keeps one file per run and remembers the last one", () => {
    expect(readLastRoutineRun(routineDir("job-1"))).toBeNull();
    expect(countRoutineRuns(routineDir("job-1"))).toBe(0);

    recordRoutineRun(routineDir("job-1"), {
      sessionId: "s1",
      startedAt: "2026-09-03T09:00:00.000Z",
      endedAt: "2026-09-03T09:00:40.000Z",
      outcome: "completed",
      reply: "3 unread since yesterday.",
    });
    recordRoutineRun(routineDir("job-1"), {
      sessionId: "s2",
      startedAt: "2026-09-03T09:05:00.000Z",
      endedAt: "2026-09-03T09:05:20.000Z",
      outcome: "failed",
      reply: "",
    });

    expect(countRoutineRuns(routineDir("job-1"))).toBe(2);
    const files = fs.readdirSync(routineRunsDir(routineDir("job-1"))).sort();
    expect(files[0]).toContain("2026-09-03T09-00-00.000Z-s1");
    expect(
      fs.readFileSync(
        path.join(routineRunsDir(routineDir("job-1")), files[0]!),
        "utf8"
      )
    ).toContain("3 unread since yesterday.");
    expect(readLastRoutineRun(routineDir("job-1"))).toMatchObject({
      sessionId: "s2",
      outcome: "failed",
    });
    expect(routineDir("job-1")).toBe(path.join(home, "routines", "job-1"));
  });

  // The field case: the 6:09 and 6:10 runs finished after the 6:15 one and
  // overwrote the pointer, so the 6:20 fire was told about 6:10.
  it("keeps the run that started last as the last, whatever finished last", () => {
    recordRoutineRun(routineDir("job-1"), {
      sessionId: "s-later",
      startedAt: "2026-09-03T12:45:16.000Z",
      endedAt: "2026-09-03T12:45:22.000Z",
      outcome: "completed",
      reply: "the 12:45 joke",
    });
    recordRoutineRun(routineDir("job-1"), {
      sessionId: "s-earlier",
      startedAt: "2026-09-03T12:40:16.000Z",
      endedAt: "2026-09-03T12:47:04.000Z",
      outcome: "completed",
      reply: "the 12:40 joke, finished late",
    });

    expect(readLastRoutineRun(routineDir("job-1"))?.sessionId).toBe("s-later");
    expect(countRoutineRuns(routineDir("job-1"))).toBe(2);
  });

  it("goes with the routine", async () => {
    recordRoutineRun(routineDir("job-1"), {
      sessionId: "s1",
      startedAt: "2026-09-03T09:00:00.000Z",
      endedAt: "2026-09-03T09:00:40.000Z",
      outcome: "completed",
      reply: "hi",
    });
    await removeRoutineDir(routineDir("job-1"));
    expect(fs.existsSync(routineDir("job-1"))).toBe(false);
    expect(readLastRoutineRun(routineDir("job-1"))).toBeNull();
  });
});

/**
 * A routine set up for a project keeps its records inside that project, so
 * the whole routine runs where the user pointed it, and never shows up in
 * the project's git status.
 */
describe("a routine's folder inside a project", () => {
  it("sits under the app's dot-folder and ignores itself", async () => {
    const project = fs.mkdtempSync(path.join(os.tmpdir(), "routine-project-"));
    const dir = routineDirInWorkspace(project, "job-2");

    expect(dir).toBe(path.join(project, ".abacusai-bot", "routines", "job-2"));

    recordRoutineRun(dir, {
      sessionId: "s-1",
      startedAt: "2026-09-16T10:00:00.000Z",
      endedAt: "2026-09-16T10:01:00.000Z",
      outcome: "completed",
      reply: "done",
    });

    expect(countRoutineRuns(dir)).toBe(1);
    expect(readLastRoutineRun(dir)?.sessionId).toBe("s-1");
    expect(
      fs.readFileSync(path.join(project, ".abacusai-bot", ".gitignore"), "utf8")
    ).toBe("*\n");
    // Nothing landed in the app's own home for it.
    expect(fs.existsSync(routineDir("job-2"))).toBe(false);

    await removeRoutineDir(dir);
    expect(fs.existsSync(dir)).toBe(false);
    // The project itself is untouched.
    expect(fs.existsSync(project)).toBe(true);
    fs.rmSync(project, { recursive: true, force: true });
  });
});

/**
 * Notes live in the routine's records folder, and notes kept anywhere the
 * routine has kept them before are found, never orphaned or overwritten.
 */
describe("a routine's notes", () => {
  let project: string;
  beforeEach(() => {
    project = fs.mkdtempSync(path.join(os.tmpdir(), "routine-notes-"));
  });
  afterEach(() => fs.rmSync(project, { recursive: true, force: true }));

  const write = (file: string, text: string, mtimeMs?: number): void => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text, "utf8");
    if (mtimeMs != null) fs.utimesSync(file, mtimeMs / 1000, mtimeMs / 1000);
  };

  it("says whether its own folder holds notes", () => {
    const home = routineDir("job-3");
    expect(routineNotes(home, "job-3", null)).toEqual({
      path: path.join(home, "notes.md"),
      kept: false,
      maybeAt: null,
    });
    write(path.join(home, "notes.md"), "seen: 4");
    expect(routineNotes(home, "job-3", null).kept).toBe(true);
  });

  // Its records were in the app's folder before it had a project: that folder
  // is the routine's alone, so its notes move in, once.
  it("brings in the notes it kept before it had a project", () => {
    const home = routineDirInWorkspace(project, "job-3");
    write(path.join(routineDir("job-3"), "notes.md"), "seen: 4");

    const notes = routineNotes(home, "job-3", { path: project, since: 0 });

    expect(notes).toEqual({
      path: path.join(home, "notes.md"),
      kept: true,
      maybeAt: null,
    });
    expect(fs.readFileSync(notes.path, "utf8")).toBe("seen: 4");
    expect(fs.existsSync(path.join(routineDir("job-3"), "notes.md"))).toBe(
      false
    );
    expect(
      fs.readFileSync(path.join(project, ".abacusai-bot", ".gitignore"), "utf8")
    ).toBe("*\n");
  });

  it("never overwrites notes already in its records folder", () => {
    const home = routineDirInWorkspace(project, "job-3");
    write(path.join(home, "notes.md"), "current");
    write(path.join(routineDir("job-3"), "notes.md"), "older");

    expect(routineNotes(home, "job-3", { path: project, since: 0 }).kept).toBe(
      true
    );
    expect(fs.readFileSync(path.join(home, "notes.md"), "utf8")).toBe(
      "current"
    );
    expect(
      fs.readFileSync(path.join(routineDir("job-3"), "notes.md"), "utf8")
    ).toBe("older");
  });

  // A bare "notes.md" once resolved to the project root. That file may be the
  // user's: it is named when a run could have written it, and never moved.
  it("names a project-root notes.md it may have written, and leaves it", () => {
    const home = routineDirInWorkspace(project, "job-3");
    const rootNotes = path.join(project, "notes.md");
    const createdAt = Date.parse("2026-10-01T00:00:00.000Z");

    write(rootNotes, "the user's", createdAt - 86_400_000);
    expect(
      routineNotes(home, "job-3", { path: project, since: createdAt }).maybeAt
    ).toBeNull();

    write(rootNotes, "seen: 4", createdAt + 86_400_000);
    expect(
      routineNotes(home, "job-3", { path: project, since: createdAt })
    ).toEqual({
      path: path.join(home, "notes.md"),
      kept: false,
      maybeAt: rootNotes,
    });
    expect(fs.readFileSync(rootNotes, "utf8")).toBe("seen: 4");

    write(path.join(home, "notes.md"), "kept");
    expect(
      routineNotes(home, "job-3", { path: project, since: createdAt }).maybeAt
    ).toBeNull();
  });
});
