/**
 * R5-T41: step 5 (`routine-attempt-ids`, spec 05 §31.5 f) against a legacy
 * home: ids minted once and persisted, kinds from main's own strings,
 * sessions recovered from `started session <id>` and from run records within
 * 2 s (the app's folder and a project's), a legacy timeout linked to its
 * attempt, `unknown` otherwise; idempotent; the file backed up as
 * `replace-user`; and every kill point of its commit settled by the next
 * launch through the runner's journal.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import type { RoutineRun } from "@abacus-ai/contract/routines";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupsRoot,
  migratingRoot,
  nodeIo,
  type MigrationIo,
} from "../backup";
import { readRecord } from "../record";
import { runMigrations } from "../runner";
import { routineAttemptIds } from "./005-routine-attempt-ids";

let root: string;
let home: string;
let userData: string;
let project: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "routine-attempts-step-"));
  home = path.join(root, "home");
  userData = path.join(root, "userdata");
  project = path.join(root, "project");
  fs.mkdirSync(userData, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(root, { recursive: true, force: true });
});

const cronjobs = () => path.join(home, "cronjobs.json");
const iso = (ms: number) => new Date(ms).toISOString();
const T0 = Date.parse("2026-09-01T09:00:00.000Z");

const runRecord = (
  dir: string,
  sessionId: string,
  startedAt: number,
  endedAt: number,
  outcome = "completed"
) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${iso(startedAt).replaceAll(":", "-")}-${sessionId}.md`),
    [
      `# Run at ${iso(startedAt)}`,
      "",
      `- Outcome: ${outcome}`,
      `- Ended: ${iso(endedAt)}`,
      `- Session: ${sessionId}`,
      "",
      "reply",
      "",
    ].join("\n")
  );
};

const job = (
  id: string,
  runs: unknown[],
  workspaceId: string | null = null
) => ({
  id,
  name: id,
  schedule: "0 9 * * *",
  runAt: null,
  webhookToken: null,
  prompt: "p",
  workspaceId,
  botId: null,
  enabled: true,
  createdAt: T0 - 1_000,
  lastRunAt: null,
  lastResult: null,
  runs,
});

/** A legacy home: two routines, one set up for a project. */
const legacyHome = () => {
  fs.writeFileSync(
    path.join(home, "local-code.json"),
    JSON.stringify({
      localCode: { workspaces: [{ id: "ws-project", path: project }] },
    })
  );
  // job-a's records live in the app's folder.
  runRecord(
    path.join(home, "routines", "job-a", "runs"),
    "s-rec",
    T0 + 1_200,
    T0 + 60_000
  );
  runRecord(
    path.join(home, "routines", "job-a", "runs"),
    "s-stuck",
    T0 + 100_000,
    T0 + 1_900_000 + 500,
    "failed"
  );
  // job-b's records live inside its project.
  runRecord(
    path.join(project, ".abacusai-bot", "routines", "job-b", "runs"),
    "s-proj",
    T0 + 5_000 - 1_800,
    T0 + 9_000
  );
  const legacy = [
    job("job-a", [
      {
        at: T0 + 1_900_000,
        trigger: "schedule",
        result: "failed: the run was stopped after 30 minutes",
      },
      {
        at: T0 + 400_000,
        trigger: "schedule",
        result: "paused after 3 failed runs in a row",
      },
      {
        at: T0 + 300_000,
        trigger: "webhook",
        result: "no workspace to run in",
      },
      {
        at: T0 + 200_000,
        trigger: "schedule",
        result: "skipped: the previous run is still going",
      },
      {
        at: T0 + 150_000,
        trigger: "manual",
        result: "session failed to start: no model",
      },
      {
        at: T0 + 100_000,
        trigger: "schedule",
        result: "started session s-stuck",
      },
      // Text an older build wrote: recovered from a record 1.2 s away.
      { at: T0, trigger: "schedule", result: "fired" },
      // Too far from any record.
      { at: T0 - 500_000, trigger: "schedule", result: "fired" },
    ]),
    job(
      "job-b",
      [{ at: T0 + 5_000, trigger: "create", result: "ran" }],
      "ws-project"
    ),
    // Already migrated: untouched.
    job("job-c", [
      {
        id: "attempt-kept",
        at: T0,
        trigger: "manual",
        result: "started session s-c",
        kind: "started",
        sessionId: "s-c",
        attemptId: null,
      },
    ]),
  ];
  const raw = `${JSON.stringify(legacy, null, 2)}\n`;
  fs.writeFileSync(cronjobs(), raw);
  return raw;
};

const run = (options: { rerun?: number[]; io?: MigrationIo } = {}) =>
  runMigrations({
    home,
    userData,
    appVersion: "0.0.0-test",
    steps: [routineAttemptIds()],
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    log: () => undefined,
    ...options,
  });

type Job = { id: string; runs: RoutineRun[] };
const stored = (): Job[] => JSON.parse(fs.readFileSync(cronjobs(), "utf8"));

describe("R5-T41 step 5 routine-attempt-ids", () => {
  it("classifies every legacy entry, recovers sessions and links the timeout", async () => {
    const original = legacyHome();
    const result = await run();
    expect(result).toMatchObject({ applied: [5], failed: null });

    const [a, b, c] = stored();
    const runs = a!.runs;
    for (const entry of [...runs, ...b!.runs])
      expect(entry.id).toMatch(/^attempt-[0-9a-f-]{36}$/);
    expect(new Set(runs.map((entry) => entry.id)).size).toBe(runs.length);
    expect(runs.map(({ kind, sessionId }) => ({ kind, sessionId }))).toEqual([
      { kind: "timed-out", sessionId: "s-stuck" },
      { kind: "paused", sessionId: null },
      { kind: "no-workspace", sessionId: null },
      { kind: "skipped", sessionId: null },
      { kind: "start-failed", sessionId: null },
      { kind: "started", sessionId: "s-stuck" },
      { kind: "unknown", sessionId: "s-rec" },
      { kind: "unknown", sessionId: null },
    ]);
    expect(runs[0]!.attemptId).toBe(runs[5]!.id);
    expect(runs.slice(1).every((entry) => entry.attemptId === null)).toBe(true);
    // A project routine's records are read inside the project.
    expect(b!.runs[0]).toMatchObject({ kind: "unknown", sessionId: "s-proj" });
    expect(c!.runs).toEqual([
      expect.objectContaining({ id: "attempt-kept", sessionId: "s-c" }),
    ]);
    // Everything else about the routines is unchanged.
    const before = JSON.parse(original) as Array<Record<string, unknown>>;
    expect(stored().map(({ runs: _runs, ...rest }) => rest)).toEqual(
      before.map(({ runs: _runs, ...rest }) => rest)
    );

    // replace-user: the original is in the backup.
    const entry = readRecord(home).applied.find((applied) => applied.id === 5);
    expect(entry?.stats).toMatchObject({
      routines: 3,
      migrated: 9,
      withSession: 4,
      unknown: 3,
      linkedTimeouts: 1,
      written: 1,
    });
    expect(
      fs.readFileSync(
        path.join(backupsRoot(home), entry!.backup!, "home", "cronjobs.json"),
        "utf8"
      )
    ).toBe(original);
  });

  it("is idempotent, and cron-store reads the same ids and keeps them", async () => {
    legacyHome();
    // Before the step: cron-store's read fallback derives the ids the step
    // will persist.
    process.env.ABACUSAI_BOT_HOME = home;
    const store = await import("../../services/agent-tools/cron-store");
    const fallback = store.getJob("job-a")!.runs.map((entry) => entry.id);

    await run();
    const after = fs.readFileSync(cronjobs());
    expect(stored()[0]!.runs.map((entry) => entry.id)).toEqual(fallback);

    const again = await run({ rerun: [5] });
    expect(again).toMatchObject({ applied: [5], failed: null });
    expect(fs.readFileSync(cronjobs()).equals(after)).toBe(true);
    expect(readRecord(home).applied.at(-1)?.stats).toMatchObject({
      migrated: 0,
      written: 0,
    });

    // New runs are prepended with fresh ids; no existing id changes.
    const added = store.recordRun(
      "job-a",
      "skipped: the previous run is still going"
    );
    const ids = store.getJob("job-a")!.runs.map((entry) => entry.id);
    expect(ids).toEqual([added!.id, ...fallback]);
    expect(added!.id).not.toBe(fallback[0]);
  });

  it("writes nothing without a file, or with one that does not parse", async () => {
    await expect(run()).resolves.toMatchObject({ applied: [5], failed: null });
    expect(fs.existsSync(cronjobs())).toBe(false);

    fs.writeFileSync(cronjobs(), "{corrupt");
    await run({ rerun: [5] });
    expect(fs.readFileSync(cronjobs(), "utf8")).toBe("{corrupt");
    // No legacy file backup; the empty commit still retains its manifest.
    expect(
      fs.readdirSync(backupsRoot(home)).some((name) => name.endsWith(".jsonl"))
    ).toBe(true);
  });

  // Claude r1 #6 / Codex r1 #17: the step did not run (an earlier step
  // failed), so cron-store's read fallback derived the ids without the run
  // records and a routine write persisted them. The step still recovers
  // every session and link, and keeps those ids.
  it("recovers sessions after a cron write persisted the fallback's ids", async () => {
    legacyHome();
    process.env.ABACUSAI_BOT_HOME = home;
    const store = await import("../../services/agent-tools/cron-store");
    const added = store.recordRun("job-a", "no workspace to run in");
    const persisted = stored()[0]!.runs;
    expect(persisted.every((entry) => typeof entry.id === "string")).toBe(true);
    expect(persisted.filter((entry) => entry.sessionId != null)).toEqual([
      expect.objectContaining({ kind: "started", sessionId: "s-stuck" }),
    ]);

    await expect(run()).resolves.toMatchObject({ applied: [5] });
    const runs = stored()[0]!.runs;
    expect(runs.map((entry) => entry.id)).toEqual(
      persisted.map((entry) => entry.id)
    );
    expect(runs[0]).toMatchObject({ id: added!.id, sessionId: null });
    expect(
      runs.slice(1).map(({ kind, sessionId }) => ({ kind, sessionId }))
    ).toEqual([
      { kind: "timed-out", sessionId: "s-stuck" },
      { kind: "paused", sessionId: null },
      { kind: "no-workspace", sessionId: null },
      { kind: "skipped", sessionId: null },
      { kind: "start-failed", sessionId: null },
      { kind: "started", sessionId: "s-stuck" },
      { kind: "unknown", sessionId: "s-rec" },
      { kind: "unknown", sessionId: null },
    ]);
    expect(runs[1]!.attemptId).toBe(runs[6]!.id);
    expect(stored()[1]!.runs[0]).toMatchObject({ sessionId: "s-proj" });
  });

  // Claude r1 #22: an entry of another shape stays where it is, whether or
  // not its job had anything to migrate.
  it("keeps malformed entries in place in every job", async () => {
    const odd = [null, { at: "yesterday" }, 7];
    fs.writeFileSync(
      cronjobs(),
      JSON.stringify([
        job("job-x", [
          { at: T0, trigger: "manual", result: "no workspace to run in" },
          ...odd,
        ]),
        job("job-y", [
          ...odd,
          {
            id: "attempt-kept",
            at: T0,
            trigger: "manual",
            result: "no workspace to run in",
            kind: "no-workspace",
            sessionId: null,
            attemptId: null,
          },
        ]),
      ])
    );
    await run();
    const [x, y] = stored() as unknown as Array<{ runs: unknown[] }>;
    expect(x!.runs.slice(1)).toEqual(odd);
    expect(x!.runs[0]).toMatchObject({ kind: "no-workspace" });
    expect(y!.runs.slice(0, 3)).toEqual(odd);
  });

  // Claude r1 #23: a legacy start failure names no session, but the session
  // store has the one it made.
  it("links a legacy start failure to the session the store holds", async () => {
    fs.writeFileSync(
      path.join(home, "local-code.json"),
      JSON.stringify({
        localCode: {
          workspaces: [],
          agentSessions: [
            {
              id: "s-failed",
              routineId: "job-f",
              createdAt: iso(T0 - 3_000),
              runOutcome: "failed",
            },
            {
              id: "s-editor",
              routineId: "job-f",
              editorFor: "job-f",
              createdAt: iso(T0 - 1_000),
            },
          ],
        },
      })
    );
    fs.writeFileSync(
      cronjobs(),
      JSON.stringify([
        job("job-f", [
          {
            at: T0,
            trigger: "manual",
            result: "session failed to start: no model",
          },
        ]),
      ])
    );
    await run();
    expect(stored()[0]!.runs[0]).toMatchObject({
      kind: "start-failed",
      sessionId: "s-failed",
    });
  });
});

// The runner's journal protocol for this step's commit (spec 00 C.1): a
// process killed at any mutation of the launch is settled by the next one,
// which ends with the file exactly as a clean launch leaves it.
describe("R5-T41 kill points", () => {
  class Killed extends Error {}

  const killing = (killAt: number): { io: MigrationIo; ops: () => number } => {
    let count = 0;
    let dead = false;
    const mutate = <T>(label: string, apply: () => T, torn?: () => void): T => {
      if (dead) throw new Killed(`dead: ${label}`);
      count += 1;
      if (count === killAt) {
        dead = true;
        torn?.();
        throw new Killed(label);
      }
      return apply();
    };
    const half = (data: string | Buffer) =>
      typeof data === "string"
        ? data.slice(0, Math.floor(data.length / 2))
        : data.subarray(0, Math.floor(data.length / 2));
    return {
      ops: () => count,
      io: {
        ...nodeIo,
        mkdirSync: (dir) => mutate("mkdir", () => nodeIo.mkdirSync(dir)),
        writeFileSync: (file, data) =>
          mutate(
            "write",
            () => nodeIo.writeFileSync(file, data),
            () => fs.writeFileSync(file, half(data))
          ),
        appendFileSync: (file, data) =>
          mutate(
            "append",
            () => nodeIo.appendFileSync(file, data),
            () => fs.appendFileSync(file, half(data))
          ),
        copyFileSync: (source, dest) =>
          mutate(
            "copy",
            () => nodeIo.copyFileSync(source, dest),
            () => fs.writeFileSync(dest, half(fs.readFileSync(source)))
          ),
        renameSync: (source, dest) =>
          mutate("rename", () => nodeIo.renameSync(source, dest)),
        rmSync: (file, options) =>
          mutate("rm", () => nodeIo.rmSync(file, options)),
        rmdirSync: (dir) => mutate("rmdir", () => nodeIo.rmdirSync(dir)),
      },
    };
  };

  it("every kill point of the commit is settled by the next launch", async () => {
    legacyHome();
    const clean = killing(Infinity);
    await run({ io: clean.io });
    const committed = fs.readFileSync(cronjobs(), "utf8");
    const points = clean.ops();
    expect(points).toBeGreaterThan(3);

    for (let k = 1; k <= points; k += 1) {
      fs.rmSync(root, { recursive: true, force: true });
      fs.mkdirSync(userData, { recursive: true });
      fs.mkdirSync(home, { recursive: true });
      const original = legacyHome();
      const kill = killing(k);
      await run({ io: kill.io }).catch(() => undefined);

      // What the kill left is either side of the commit, never a torn file.
      expect([original, committed]).toContain(
        fs.readFileSync(cronjobs(), "utf8")
      );

      const next = await run();
      expect(next.failed).toBeNull();
      expect({ k, file: fs.readFileSync(cronjobs(), "utf8") }).toEqual({
        k,
        file: committed,
      });
      expect(
        readRecord(home).applied.filter((entry) => entry.id === 5)
      ).toHaveLength(1);
      expect(fs.existsSync(migratingRoot(home))).toBe(false);
    }
  });
});
