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
    expect(readLastRoutineRun("job-1")).toBeNull();
    expect(countRoutineRuns("job-1")).toBe(0);

    recordRoutineRun("job-1", {
      sessionId: "s1",
      startedAt: "2026-09-03T09:00:00.000Z",
      endedAt: "2026-09-03T09:00:40.000Z",
      outcome: "completed",
      reply: "3 unread since yesterday.",
    });
    recordRoutineRun("job-1", {
      sessionId: "s2",
      startedAt: "2026-09-03T09:05:00.000Z",
      endedAt: "2026-09-03T09:05:20.000Z",
      outcome: "failed",
      reply: "",
    });

    expect(countRoutineRuns("job-1")).toBe(2);
    const files = fs.readdirSync(routineRunsDir("job-1")).sort();
    expect(files[0]).toContain("2026-09-03T09-00-00.000Z-s1");
    expect(
      fs.readFileSync(path.join(routineRunsDir("job-1"), files[0]!), "utf8")
    ).toContain("3 unread since yesterday.");
    expect(readLastRoutineRun("job-1")).toMatchObject({
      sessionId: "s2",
      outcome: "failed",
    });
    expect(routineDir("job-1")).toBe(path.join(home, "routines", "job-1"));
  });

  // The field case: the 6:09 and 6:10 runs finished after the 6:15 one and
  // overwrote the pointer, so the 6:20 fire was told about 6:10.
  it("keeps the run that started last as the last, whatever finished last", () => {
    recordRoutineRun("job-1", {
      sessionId: "s-later",
      startedAt: "2026-09-03T12:45:16.000Z",
      endedAt: "2026-09-03T12:45:22.000Z",
      outcome: "completed",
      reply: "the 12:45 joke",
    });
    recordRoutineRun("job-1", {
      sessionId: "s-earlier",
      startedAt: "2026-09-03T12:40:16.000Z",
      endedAt: "2026-09-03T12:47:04.000Z",
      outcome: "completed",
      reply: "the 12:40 joke, finished late",
    });

    expect(readLastRoutineRun("job-1")?.sessionId).toBe("s-later");
    expect(countRoutineRuns("job-1")).toBe(2);
  });

  it("goes with the routine", () => {
    recordRoutineRun("job-1", {
      sessionId: "s1",
      startedAt: "2026-09-03T09:00:00.000Z",
      endedAt: "2026-09-03T09:00:40.000Z",
      outcome: "completed",
      reply: "hi",
    });
    removeRoutineDir("job-1");
    expect(fs.existsSync(routineDir("job-1"))).toBe(false);
    expect(readLastRoutineRun("job-1")).toBeNull();
  });
});
