/**
 * C-T3: the migration runner against a temp home and userData. Order,
 * idempotence, the record written only after the commit, plan failures,
 * commit recovery from the journal (in this launch and the next), unresolved
 * attempts, the record's states, rerun and pruning. The filesystem-level
 * kill harness is `runner.crash.test.ts`.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupDirName,
  backupsRoot,
  formatStamp,
  migratingRoot,
  nodeIo,
  quarantineDirFor,
  quarantineRoot,
  type MigrationIo,
} from "./backup";
import { JOURNAL_NAME, LOG_NAME, type CommitJournal } from "./journal";
import { readRecord, readRecordState, recordFile } from "./record";
import {
  isWriteBlocked,
  runMigrations,
  type RunMigrationsOptions,
} from "./runner";
import type { MigrationContext, MigrationStep, WriteKind } from "./types";

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-"));
  home = path.join(root, "home");
  userData = path.join(home, "electron");
  fs.mkdirSync(userData, { recursive: true });
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface FileSpec {
  dest: string;
  content: string;
  kind: WriteKind;
}

const fileStep = (
  id: number,
  name: string,
  files: (ctx: MigrationContext) => FileSpec[],
  options: { removals?: () => string[]; calls?: string[] } = {}
): MigrationStep => ({
  id,
  name,
  plan: async (ctx) => {
    options.calls?.push(name);
    const writes = files(ctx).map((file, index) => {
      const staged = path.join(ctx.staging, `${index}.out`);
      fs.writeFileSync(staged, file.content);
      return { dest: file.dest, staged, kind: file.kind };
    });
    return {
      writes,
      removals: options.removals?.() ?? [],
      stats: { files: writes.length },
    };
  },
});

const run = (
  steps: MigrationStep[],
  extra: Partial<RunMigrationsOptions> = {}
) =>
  runMigrations({
    home,
    userData,
    appVersion: "9.9.9",
    steps,
    log: () => undefined,
    ...extra,
  });

const read = (file: string): string | null =>
  fs.existsSync(file) ? fs.readFileSync(file, "utf8") : null;

/** Every file under `dir`, relative, with its content (the home's state). */
const tree = (dir: string, skip: (rel: string) => boolean = () => false) => {
  const out: Record<string, string> = {};
  const walk = (current: string) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = path.relative(dir, full);
      if (skip(rel)) continue;
      if (entry.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  if (fs.existsSync(dir)) walk(dir);
  return out;
};

const journalAt = (staging: string): CommitJournal =>
  JSON.parse(
    fs.readFileSync(path.join(staging, JOURNAL_NAME), "utf8")
  ) as CommitJournal;

describe("C-T3 runner", () => {
  it("runs pending steps in ascending id, once", async () => {
    const calls: string[] = [];
    const a = path.join(home, "a.json");
    const b = path.join(userData, "b.json");
    const steps = [
      fileStep(2, "second", () => [{ dest: b, content: "B", kind: "create" }], {
        calls,
      }),
      fileStep(1, "first", () => [{ dest: a, content: "A", kind: "create" }], {
        calls,
      }),
    ];

    const first = await run(steps);
    expect(first).toMatchObject({
      applied: [1, 2],
      failed: null,
      unresolved: [],
    });
    expect(calls).toEqual(["first", "second"]);
    expect([read(a), read(b)]).toEqual(["A", "B"]);
    const record = readRecord(home);
    expect(record.applied.map((entry) => [entry.id, entry.name])).toEqual([
      [1, "first"],
      [2, "second"],
    ]);
    expect(record.applied[0]).toMatchObject({
      appVersion: "9.9.9",
      stats: { files: 1 },
    });
    expect(record.applied[0]?.attempt).toMatch(/^[0-9a-f]{16}$/);
    expect(record.applied[0]?.attempt).not.toBe(record.applied[1]?.attempt);
    expect(fs.existsSync(migratingRoot(home))).toBe(false);

    const second = await run(steps);
    expect(second).toMatchObject({ applied: [], failed: null });
    expect(calls).toEqual(["first", "second"]);
  });

  it("writes the record only after every move", async () => {
    const a = path.join(home, "a.json");
    let seen: unknown = "unset";
    await run(
      [fileStep(1, "one", () => [{ dest: a, content: "A", kind: "create" }])],
      {
        hooks: {
          beforeRecord: () => {
            seen = { dest: read(a), applied: readRecord(home).applied.length };
          },
        },
      }
    );
    expect(seen).toEqual({ dest: "A", applied: 0 });
    expect(readRecord(home).applied).toHaveLength(1);
  });

  it("writes the journal once and appends one done line per move", async () => {
    const files = Array.from({ length: 45 }, (_, index) => ({
      dest: path.join(home, "threads", `${index}.json`),
      content: String(index),
      kind: "create" as const,
    }));
    const renames: string[] = [];
    const io: MigrationIo = {
      ...nodeIo,
      renameSync: (source, dest) => {
        renames.push(path.basename(dest));
        nodeIo.renameSync(source, dest);
      },
    };
    let log = "";
    const progress: number[] = [];
    await run([fileStep(1, "many", () => files)], {
      io,
      onProgress: (done) => progress.push(done),
      hooks: {
        beforeRecord: () => {
          log = fs.readFileSync(
            path.join(migratingRoot(home), "1-many", LOG_NAME),
            "utf8"
          );
        },
      },
    });
    expect(renames.filter((name) => name === JOURNAL_NAME)).toHaveLength(1);
    expect(log.trim().split("\n")).toHaveLength(45);
    // The commit reports progress between the plan's share and the end.
    expect(progress.some((done) => done > 800 && done < 1000)).toBe(true);
  });

  it("yields to the event loop during a large commit", async () => {
    const files = Array.from({ length: 100 }, (_, index) => ({
      dest: path.join(home, "threads", `${index}.json`),
      content: String(index),
      kind: "create" as const,
    }));
    let ticks = 0;
    let moves = 0;
    const timer = setInterval(() => {
      ticks += 1;
    }, 0);
    const ticksAt: number[] = [];
    await run([fileStep(1, "many", () => files)], {
      yieldEvery: 10,
      hooks: {
        afterMove: () => {
          moves += 1;
          if (moves % 10 === 0) ticksAt.push(ticks);
        },
      },
    });
    clearInterval(timer);
    expect(new Set(ticksAt).size).toBeGreaterThan(1);
  });

  it("a throwing plan leaves no staging, records the failure, stops, and retries next launch", async () => {
    const calls: string[] = [];
    let broken = true;
    const steps: MigrationStep[] = [
      {
        id: 1,
        name: "flaky",
        plan: async (ctx) => {
          calls.push("flaky");
          fs.writeFileSync(path.join(ctx.staging, "partial"), "x");
          if (broken) throw new Error("disk on fire");
          return { writes: [], removals: [], stats: {} };
        },
      },
      fileStep(2, "later", () => [], { calls }),
    ];

    const first = await run(steps);
    expect(first.failed).toMatchObject({ id: 1, error: "disk on fire" });
    expect(calls).toEqual(["flaky"]);
    expect(fs.existsSync(path.join(migratingRoot(home), "1-flaky"))).toBe(
      false
    );
    expect(readRecord(home)).toMatchObject({
      applied: [],
      lastFailure: { id: 1, name: "flaky", error: "disk on fire" },
    });

    broken = false;
    const second = await run(steps);
    expect(second).toMatchObject({ applied: [1, 2], failed: null });
    expect(readRecord(home).lastFailure).toBeUndefined();
  });

  describe("plan validation", () => {
    const planned = (plan: Awaited<ReturnType<MigrationStep["plan"]>>) =>
      run([{ id: 1, name: "bad", plan: async () => plan }]);

    it("refuses a staged file outside the staging", async () => {
      const outside = path.join(root, "outside");
      fs.writeFileSync(outside, "x");
      const result = await planned({
        writes: [
          { dest: path.join(home, "x"), staged: outside, kind: "create" },
        ],
        removals: [],
        stats: {},
      });
      expect(result.failed?.error).toMatch(/not in the staging/);
      expect(fs.existsSync(path.join(home, "x"))).toBe(false);
    });

    it("refuses a destination outside the home and userData, or in the runner's own files", async () => {
      for (const dest of [
        path.join(root, "elsewhere.json"),
        path.join(home, "backups", "migrations", "x"),
        recordFile(home),
      ]) {
        const result = await run([
          {
            id: 1,
            name: "bad",
            plan: async (ctx) => {
              const staged = path.join(ctx.staging, "0");
              fs.writeFileSync(staged, "x");
              return {
                writes: [{ dest, staged, kind: "create" }],
                removals: [],
                stats: {},
              };
            },
          },
        ]);
        expect(result.failed?.error).toMatch(/not under the home/);
      }
    });

    it("refuses two writes sharing one staged file", async () => {
      const result = await run([
        {
          id: 1,
          name: "bad",
          plan: async (ctx) => {
            const staged = path.join(ctx.staging, "0");
            fs.writeFileSync(staged, "x");
            return {
              writes: [
                { dest: path.join(home, "a"), staged, kind: "create" },
                { dest: path.join(home, "b"), staged, kind: "create" },
              ],
              removals: [],
              stats: {},
            };
          },
        },
      ]);
      expect(result.failed?.error).toMatch(/used twice/);
      expect(read(path.join(home, "a"))).toBeNull();
    });
  });

  describe("commit recovery", () => {
    const paths = (base: string) => ({
      user: path.join(base, "prefs.json"),
      created: path.join(base, "threads", "new.json"),
      derived: path.join(base, "threads", "derived.json"),
    });
    const setupThree = () => {
      const { user, created, derived } = paths(home);
      fs.mkdirSync(path.dirname(derived), { recursive: true });
      fs.writeFileSync(user, "USER-ORIGINAL");
      fs.writeFileSync(derived, "DERIVED-OLD");
      const files = (ctx: MigrationContext): FileSpec[] => {
        const at = paths(ctx.home);
        return [
          { dest: at.user, content: "USER-NEW", kind: "replace-user" },
          { dest: at.created, content: "CREATED", kind: "create" },
          { dest: at.derived, content: "DERIVED-NEW", kind: "replace-derived" },
        ];
      };
      return { user, created, derived, step: fileStep(1, "three", files) };
    };
    const staging = () => path.join(migratingRoot(home), "1-three");

    it("a crash after the first of three moves is undone on the next launch", async () => {
      const { user, created, derived, step } = setupThree();

      const crashed = await run([step], {
        hooks: { afterMove: (index) => (index === 0 ? "crash" : undefined) },
      });
      expect(crashed.crashed).toBe(true);
      expect(read(user)).toBe("USER-NEW");
      expect(journalAt(staging()).version).toBe(2);
      expect(readRecord(home).applied).toEqual([]);

      // Next launch: recovery puts the user file back (seen here with no
      // steps registered), then the step runs again from scratch.
      const recovery = await run([]);
      expect(recovery.recovered).toEqual([
        { staging: staging(), action: "undone" },
      ]);
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-ORIGINAL",
        null,
        "DERIVED-OLD",
      ]);

      const next = await run([step]);
      expect(next).toMatchObject({ applied: [1], failed: null });
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-NEW",
        "CREATED",
        "DERIVED-NEW",
      ]);
      expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([1]);
    });

    it("undoes every kind by its rule when the crash follows all moves", async () => {
      const { user, created, derived, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-NEW",
        "CREATED",
        "DERIVED-NEW",
      ]);

      const recovered = await run([]);
      expect(recovered.recovered[0]?.action).toBe("undone");
      expect(read(user)).toBe("USER-ORIGINAL");
      expect(read(created)).toBeNull();
      // Derived data is left: it is correct or will be regenerated.
      expect(read(derived)).toBe("DERIVED-NEW");
      expect(fs.existsSync(migratingRoot(home))).toBe(false);
      // The attempt's backups went with it.
      expect(fs.readdirSync(backupsRoot(home))).toEqual([]);
    });

    it("undoes by rule when no done line was written (moved, not logged)", async () => {
      const { user, created, derived, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      fs.writeFileSync(path.join(staging(), LOG_NAME), "");

      await run([]);
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-ORIGINAL",
        null,
        "DERIVED-NEW",
      ]);
    });

    it("a failure after all moves but before the record reruns to an identical result", async () => {
      const { step } = setupThree();
      const clean = path.join(root, "clean");
      fs.cpSync(home, clean, { recursive: true });

      await run([step], { hooks: { beforeRecord: () => "crash" } });
      const rerun = await run([step]);
      expect(rerun.applied).toEqual([1]);

      const cleanResult = await runMigrations({
        home: clean,
        userData: path.join(clean, "electron"),
        appVersion: "9.9.9",
        steps: [step],
        log: () => undefined,
      });
      expect(cleanResult.applied).toEqual([1]);
      const state = (dir: string) =>
        tree(
          dir,
          (rel) => rel.startsWith("backups") || rel === "migrations.json"
        );
      expect(state(home)).toEqual(state(clean));
    });

    it("a throw during the commit is undone in the same launch", async () => {
      const { user, created, derived, step } = setupThree();
      const result = await run([step], {
        hooks: {
          afterMove: (index) => {
            if (index === 1) throw new Error("EIO");
          },
        },
      });
      expect(result.failed).toMatchObject({ id: 1, error: "EIO" });
      expect(result.unresolved).toEqual([]);
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-ORIGINAL",
        null,
        "DERIVED-OLD",
      ]);
      expect(fs.existsSync(staging())).toBe(false);
      expect(readRecord(home).lastFailure?.id).toBe(1);
    });

    it("finishes a recorded commit whose staging survived (the real window), without undoing it", async () => {
      const a = path.join(home, "a.json");
      fs.writeFileSync(a, "OLD");
      const step = fileStep(1, "one", () => [
        { dest: a, content: "NEW", kind: "replace-user" },
      ]);
      const crashed = await run([step], {
        hooks: { afterRecord: () => "crash" },
      });
      expect(crashed.crashed).toBe(true);
      const at = path.join(migratingRoot(home), "1-one");
      expect(fs.existsSync(path.join(at, JOURNAL_NAME))).toBe(true);

      const result = await run([step]);
      expect(result.recovered).toEqual([{ staging: at, action: "finished" }]);
      expect(read(a)).toBe("NEW");
      expect(result.applied).toEqual([]);
    });

    it("finishes a recorded commit by its log line even when the record is corrupt", async () => {
      const a = path.join(home, "a.json");
      fs.writeFileSync(a, "OLD");
      const step = fileStep(1, "one", () => [
        { dest: a, content: "NEW", kind: "replace-user" },
      ]);
      await run([step], { hooks: { afterRecord: () => "crash" } });
      fs.writeFileSync(recordFile(home), "{torn");

      const result = await run([]);
      expect(result.recovered[0]?.action).toBe("finished");
      expect(result.unresolved).toEqual([]);
      expect(read(a)).toBe("NEW");
    });

    it("tells two steps committed in the same millisecond apart by attempt", async () => {
      const fixed = new Date("2026-09-30T12:00:00.000Z");
      const a = path.join(home, "a.json");
      const b = path.join(home, "b.json");
      fs.writeFileSync(b, "B-OLD");
      const steps = [
        fileStep(1, "one", () => [{ dest: a, content: "A", kind: "create" }]),
        fileStep(2, "two", () => [
          { dest: b, content: "B-NEW", kind: "replace-user" },
        ]),
      ];
      await run(steps, {
        now: () => fixed,
        hooks: {
          afterMove: (_, dest) => (dest === b ? "crash" : undefined),
        },
      });
      const record = readRecord(home);
      expect(record.applied.map((entry) => entry.id)).toEqual([1]);
      expect(record.applied[0]?.commit).toBe(
        journalAt(path.join(migratingRoot(home), "2-two")).commit
      );

      const result = await run([], { now: () => fixed });
      expect(result.recovered[0]?.action).toBe("undone");
      expect(read(b)).toBe("B-OLD");
      expect(read(a)).toBe("A");
    });

    it("recovers when the missing-backup case is already restored (no permanent dead end)", async () => {
      const { user, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      // A rollback put the file back, then died before its log line; later
      // the backup went (as a crash between the backup and journal deletion
      // could do under the old order).
      fs.writeFileSync(user, "USER-ORIGINAL");
      fs.rmSync(backupsRoot(home), { recursive: true, force: true });

      const calls: string[] = [];
      const result = await run([
        step,
        fileStep(2, "later", () => [], { calls }),
      ]);
      expect(result.unresolved).toEqual([]);
      expect(result.applied).toEqual([1, 2]);
      expect(read(user)).toBe("USER-NEW");
    });

    it("keeps an unresolved attempt, blocks its destinations, and runs no step when a needed backup is gone", async () => {
      const { user, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      fs.rmSync(backupsRoot(home), { recursive: true, force: true });
      const calls: string[] = [];

      const result = await run([
        step,
        fileStep(2, "later", () => [], { calls }),
      ]);
      expect(result.failed?.error).toMatch(/recovery failed/);
      expect(calls).toEqual([]);
      expect(result.unresolved[0]).toMatchObject({ id: 1, name: "three" });
      expect(isWriteBlocked(result, user)).toBe(true);
      expect(isWriteBlocked(result, path.join(home, "other.json"))).toBe(false);
      expect(fs.existsSync(path.join(staging(), JOURNAL_NAME))).toBe(true);
      expect(read(user)).toBe("USER-NEW");
    });

    it("keeps a user file changed after the commit rather than restoring over it", async () => {
      const { user, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      fs.writeFileSync(user, "USER CHOICE");
      const notes: string[] = [];

      await run([], { log: (message) => notes.push(message) });
      expect(read(user)).toBe("USER CHOICE");
      expect(notes.join("\n")).toMatch(/changed after the commit/);
    });

    it("finishes recovery against the original record before --rerun-migration", async () => {
      const a = path.join(home, "a.json");
      fs.writeFileSync(a, "OLD");
      const calls: string[] = [];
      const step = fileStep(
        1,
        "one",
        () => [{ dest: a, content: "NEW", kind: "replace-user" }],
        { calls }
      );
      await run([step], { hooks: { afterRecord: () => "crash" } });
      fs.writeFileSync(a, "LATER");
      // Drop the log's `recorded` line: only the record proves completion.
      const log = path.join(migratingRoot(home), "1-one", LOG_NAME);
      fs.writeFileSync(
        log,
        fs
          .readFileSync(log, "utf8")
          .split("\n")
          .filter((line) => !line.includes('"recorded"'))
          .join("\n")
      );

      const result = await run([step], { rerun: [1] });
      expect(result.recovered[0]?.action).toBe("finished");
      // Re-planned from the current file, not rolled back to OLD.
      expect(calls).toEqual(["one", "one"]);
      expect(read(a)).toBe("NEW");
      const backups = fs.readdirSync(backupsRoot(home));
      const latest = backups.sort().at(-1) ?? "";
      expect(read(path.join(backupsRoot(home), latest, "home", "a.json"))).toBe(
        "LATER"
      );
    });
  });

  describe("journals that cannot be trusted", () => {
    const setup = async () => {
      const user = path.join(home, "prefs.json");
      fs.writeFileSync(user, "OLD");
      const step = fileStep(1, "one", () => [
        { dest: user, content: "NEW", kind: "replace-user" },
      ]);
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      const at = path.join(migratingRoot(home), "1-one");
      return { user, step, at, journal: journalAt(at) };
    };

    const expectKept = async (
      at: string,
      user: string,
      step: MigrationStep
    ) => {
      const before = tree(root);
      const calls: string[] = [];
      const result = await run([
        step,
        fileStep(2, "later", () => [], { calls }),
      ]);
      expect(result.failed?.error).toMatch(/recovery failed/);
      expect(result.unresolved).toHaveLength(1);
      expect(calls).toEqual([]);
      // Nothing touched but the record's lastFailure.
      const after = tree(root);
      delete before[path.relative(root, recordFile(home))];
      delete after[path.relative(root, recordFile(home))];
      expect(after).toEqual(before);
      expect(read(user)).toBe("NEW");
      expect(fs.existsSync(at)).toBe(true);
      return result;
    };

    it("keeps a corrupt journal, its staging and its backups, and blocks every destination", async () => {
      const { user, step, at } = await setup();
      fs.writeFileSync(path.join(at, JOURNAL_NAME), "{half");
      const result = await expectKept(at, user, step);
      expect(result.unresolved[0]?.destinations).toBeNull();
      expect(isWriteBlocked(result, path.join(home, "anything"))).toBe(true);
      // A later launch does not prune the backups it may need.
      const again = await run([], { now: () => new Date("2027-12-01") });
      expect(again.unresolved).toHaveLength(1);
      expect(fs.readdirSync(backupsRoot(home))).toHaveLength(1);
    });

    it.each([
      [
        "an unsupported version",
        (j: CommitJournal) => ({ ...j, version: 999 }),
      ],
      [
        "an unknown kind",
        (j: CommitJournal) => ({
          ...j,
          writes: j.writes.map((w) => ({ ...w, kind: "obliterate" })),
        }),
      ],
      [
        "a replace-user without its backup",
        (j: CommitJournal) => ({
          ...j,
          writes: j.writes.map((w) => ({ ...w, backup: null })),
        }),
      ],
      [
        "a destination outside the home",
        (j: CommitJournal) => ({
          ...j,
          writes: j.writes.map((w) => ({ ...w, dest: "/etc/passwd" })),
        }),
      ],
      [
        "a backup directory elsewhere",
        (j: CommitJournal) => ({ ...j, backupDir: root }),
      ],
      ["no attempt id", (j: CommitJournal) => ({ ...j, attempt: undefined })],
      [
        "a step that is not its staging's",
        (j: CommitJournal) => ({ ...j, id: 7 }),
      ],
    ])("keeps a journal with %s, touching nothing", async (_, corrupt) => {
      const { user, step, at, journal } = await setup();
      fs.writeFileSync(
        path.join(at, JOURNAL_NAME),
        JSON.stringify(corrupt(journal))
      );
      const result = await expectKept(at, user, step);
      expect(result.unresolved[0]?.error).toMatch(/invalid journal/);
    });

    it("keeps a journal whose log has a malformed line before its end", async () => {
      const { user, step, at } = await setup();
      fs.writeFileSync(path.join(at, LOG_NAME), 'garbage\n{"attempt":"x"}\n');
      await expectKept(at, user, step);
    });

    it("ignores a torn last log line", async () => {
      const { user, at } = await setup();
      fs.appendFileSync(path.join(at, LOG_NAME), '{"attempt":"ab');
      const result = await run([]);
      expect(result.recovered[0]?.action).toBe("undone");
      expect(read(user)).toBe("OLD");
    });

    it("keeps a journal it cannot read (not only a missing one is missing)", async () => {
      const { user, step, at } = await setup();
      const io: MigrationIo = {
        ...nodeIo,
        readFileSync: (file) => {
          if (file.endsWith(JOURNAL_NAME))
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return nodeIo.readFileSync(file);
        },
      };
      const result = await run([step], { io });
      expect(result.unresolved[0]?.error).toMatch(/unreadable/);
      expect(read(user)).toBe("NEW");
      expect(fs.existsSync(path.join(at, JOURNAL_NAME))).toBe(true);
    });

    it("runs nothing when .migrating cannot be listed", async () => {
      const calls: string[] = [];
      fs.mkdirSync(migratingRoot(home), { recursive: true });
      const io: MigrationIo = {
        ...nodeIo,
        readdirSync: (dir) => {
          if (dir === migratingRoot(home))
            throw Object.assign(new Error("EIO"), { code: "EIO" });
          return nodeIo.readdirSync(dir);
        },
      };
      const result = await run([fileStep(1, "one", () => [], { calls })], {
        io,
      });
      expect(calls).toEqual([]);
      expect(result.unresolved[0]?.destinations).toBeNull();
    });

    it("discards staging without a journal", async () => {
      const bare = path.join(migratingRoot(home), "7-bare");
      fs.mkdirSync(bare, { recursive: true });
      fs.writeFileSync(path.join(bare, "0.out"), "x");

      const result = await run([]);
      expect(result.recovered).toEqual([
        { staging: bare, action: "discarded" },
      ]);
      expect(fs.existsSync(migratingRoot(home))).toBe(false);
    });
  });

  describe("the record", () => {
    it("with a corrupt record and an interrupted commit, keeps everything (completion is unknown)", async () => {
      const user = path.join(home, "prefs.json");
      fs.writeFileSync(user, "OLD");
      const step = fileStep(1, "one", () => [
        { dest: user, content: "NEW", kind: "replace-user" },
      ]);
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      fs.writeFileSync(recordFile(home), "{nope");

      const result = await run([step]);
      expect(result.unresolved[0]?.error).toMatch(/record is corrupt/);
      expect(read(user)).toBe("NEW");
      expect(read(recordFile(home))).toBe("{nope");
    });

    it("sets a corrupt record aside and runs the steps again when nothing is pending", async () => {
      const calls: string[] = [];
      const step = fileStep(1, "one", () => [], { calls });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(recordFile(home), "{nope");
      await run([step]);
      expect(calls).toEqual(["one"]);
      expect(readRecord(home).applied).toHaveLength(1);
      const aside = fs
        .readdirSync(home)
        .filter((name) => name.startsWith("migrations.json.corrupt-"));
      expect(aside).toHaveLength(1);
      expect(read(path.join(home, aside[0] ?? ""))).toBe("{nope");
    });

    it("runs nothing and never writes a record from a newer build", async () => {
      const calls: string[] = [];
      const newer = JSON.stringify({ version: 2, applied: [], extra: 1 });
      fs.writeFileSync(recordFile(home), newer);
      const result = await run([fileStep(1, "one", () => [], { calls })]);
      expect(result.skipped).toBe("newer-record");
      expect(calls).toEqual([]);
      expect(read(recordFile(home))).toBe(newer);
    });

    it("runs nothing when the record cannot be read", async () => {
      const calls: string[] = [];
      fs.writeFileSync(recordFile(home), "{}");
      const io: MigrationIo = {
        ...nodeIo,
        readFileSync: (file) => {
          if (file === recordFile(home))
            throw Object.assign(new Error("EACCES"), { code: "EACCES" });
          return nodeIo.readFileSync(file);
        },
      };
      const result = await run([fileStep(1, "one", () => [], { calls })], {
        io,
      });
      expect(calls).toEqual([]);
      expect(result.failed?.error).toMatch(/cannot read/);
      expect(readRecordState(home).status).toBe("corrupt");
    });
  });

  it("moves removals into the backup and restores them on undo", async () => {
    const old = path.join(home, "transcripts", "old.json");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "V1");
    const step = fileStep(4, "archive", () => [], { removals: () => [old] });

    await run([step], { hooks: { beforeRecord: () => "crash" } });
    expect(read(old)).toBeNull();
    await run([]);
    expect(read(old)).toBe("V1");

    await run([step]);
    expect(read(old)).toBeNull();
    const [backup] = fs.readdirSync(backupsRoot(home));
    expect(
      read(
        path.join(
          backupsRoot(home),
          backup ?? "",
          "home",
          "transcripts",
          "old.json"
        )
      )
    ).toBe("V1");
  });

  it("keeps the journal when a removed file and its backup are both gone", async () => {
    const old = path.join(home, "transcripts", "old.json");
    fs.mkdirSync(path.dirname(old), { recursive: true });
    fs.writeFileSync(old, "V1");
    const step = fileStep(4, "archive", () => [], { removals: () => [old] });
    await run([step], { hooks: { beforeRecord: () => "crash" } });
    fs.rmSync(backupsRoot(home), { recursive: true, force: true });

    const result = await run([]);
    expect(result.unresolved[0]?.error).toMatch(/both missing/);
    expect(
      fs.existsSync(path.join(migratingRoot(home), "4-archive", JOURNAL_NAME))
    ).toBe(true);
  });

  it("backs up replace-user destinations and never a create", async () => {
    const user = path.join(userData, "state.json");
    fs.writeFileSync(user, "MINE");
    const fresh = path.join(home, "fresh.json");
    await run([
      fileStep(1, "one", () => [
        { dest: user, content: "NEW", kind: "replace-user" },
        { dest: fresh, content: "F", kind: "create" },
      ]),
    ]);
    const [dir] = fs.readdirSync(backupsRoot(home));
    expect(dir).toBe(readRecord(home).applied[0]?.backup);
    expect(tree(path.join(backupsRoot(home), dir ?? ""))).toEqual({
      [path.join("home", "electron", "state.json")]: "MINE",
    });
  });

  it("--rerun-migration runs the id again", async () => {
    const calls: string[] = [];
    const steps = [
      fileStep(1, "one", () => [], { calls }),
      fileStep(2, "two", () => [], { calls }),
    ];
    await run(steps);
    await run(steps, { rerun: [2] });
    expect(calls).toEqual(["one", "two", "two"]);
    expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([1, 2]);
  });

  describe("pruning", () => {
    const now = new Date("2026-09-30T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const stamp = (daysAgo: number) =>
      formatStamp(new Date(now.getTime() - daysAgo * day));

    it("prunes on a launch with nothing pending: applied backups past 30 days or beyond the newest 3 per step; orphans only by age", async () => {
      const backups = backupsRoot(home);
      const make = (daysAgo: number, id: number, attempt: string) => {
        const name = backupDirName(stamp(daysAgo), id, "a", attempt);
        fs.mkdirSync(path.join(backups, name), { recursive: true });
        return name;
      };
      const applied = [1, 2, 3, 4].map((days) =>
        make(days, 1, `${days}`.padStart(16, "0"))
      );
      const old2 = make(31, 2, "b".repeat(16));
      const orphanNew = make(0.5, 1, "c".repeat(16));
      const orphanOld = make(40, 1, "d".repeat(16));
      fs.mkdirSync(path.join(backups, "unrelated"), { recursive: true });
      fs.mkdirSync(path.join(backups, `.pruning-${stamp(2)}-1-a-x`), {
        recursive: true,
      });
      const entry = (backup: string, id: number) => ({
        id,
        name: "a",
        appliedAt: "",
        appVersion: "",
        durationMs: 0,
        stats: {},
        commit: backup.slice(0, 19),
        attempt: backup.slice(-16),
        backup,
      });
      fs.writeFileSync(
        recordFile(home),
        JSON.stringify({
          version: 1,
          applied: [...applied.map((name) => entry(name, 1)), entry(old2, 2)],
        })
      );

      const result = await run([], { now: () => now });
      expect(result).toMatchObject({ failed: null, unresolved: [] });
      expect(fs.readdirSync(backups).sort()).toEqual(
        [...applied.slice(0, 3), orphanNew, "unrelated"].sort()
      );
      expect(fs.existsSync(path.join(backups, orphanOld))).toBe(false);
    });

    it("ages quarantine by its run's stamp, not the file's mtime", async () => {
      const oldRun = quarantineDirFor(home, "transcripts", stamp(91));
      const newRun = quarantineDirFor(home, "transcripts", stamp(1));
      for (const dir of [oldRun, newRun]) {
        fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(path.join(dir, "t.json"), "x");
      }
      // A file moved in keeps an old mtime; its run is new.
      const ancient = new Date(now.getTime() - 400 * day);
      fs.utimesSync(path.join(newRun, "t.json"), ancient, ancient);
      fs.writeFileSync(path.join(quarantineRoot(home), "transcripts", "x"), "");

      await run([], { now: () => now });
      expect(fs.existsSync(oldRun)).toBe(false);
      expect(fs.existsSync(path.join(newRun, "t.json"))).toBe(true);
      expect(
        fs.existsSync(path.join(quarantineRoot(home), "transcripts", "x"))
      ).toBe(true);
    });
  });

  it("reports progress across steps", async () => {
    const progress: [number, number, string][] = [];
    await run(
      [
        {
          id: 1,
          name: "one",
          plan: async (ctx) => {
            ctx.progress(1, 2, "half");
            return { writes: [], removals: [], stats: {} };
          },
        },
        fileStep(2, "two", () => []),
      ],
      {
        onProgress: (done, total, label) => progress.push([done, total, label]),
      }
    );
    expect(progress).toContainEqual([400, 2000, "half"]);
    expect(progress.at(-1)).toEqual([2000, 2000, "two"]);
  });
});

describe("C-T3 runner: pending work", () => {
  it("commits a plan with pending work without recording it, and finishes on the next launch", async () => {
    const out = path.join(home, "out.json");
    const later = path.join(home, "later.json");
    let launches = 0;
    const step: MigrationStep = {
      id: 7,
      name: "two-phase",
      plan: async (ctx) => {
        launches += 1;
        const staged = path.join(ctx.staging, "out");
        fs.writeFileSync(staged, `launch ${launches}`);
        return {
          writes: [
            {
              dest: launches === 1 ? out : later,
              staged,
              kind: "create",
            },
          ],
          removals: [],
          stats: { launch: launches },
          pending: launches === 1 ? 1 : 0,
        };
      },
    };
    const after = fileStep(8, "after", () => [
      { dest: path.join(home, "after.json"), content: "x", kind: "create" },
    ]);

    const first = await run([step, after]);
    expect(first).toMatchObject({ applied: [8], partial: [7], failed: null });
    expect(read(out)).toBe("launch 1");
    expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([8]);
    expect(fs.existsSync(migratingRoot(home))).toBe(false);

    const second = await run([step, after]);
    expect(second).toMatchObject({ applied: [7], partial: [], failed: null });
    expect([read(out), read(later)]).toEqual(["launch 1", "launch 2"]);
    expect(readRecord(home).applied.map((entry) => entry.id)).toEqual([8, 7]);
    expect(await run([step, after])).toMatchObject({
      applied: [],
      partial: [],
    });
  });

  it("undoes a pending commit that crashed before the record point", async () => {
    const out = path.join(home, "out.json");
    const step: MigrationStep = {
      id: 7,
      name: "two-phase",
      plan: async (ctx) => {
        const staged = path.join(ctx.staging, "out");
        fs.writeFileSync(staged, "x");
        return {
          writes: [{ dest: out, staged, kind: "create" }],
          removals: [],
          stats: {},
          pending: 1,
        };
      },
    };
    const crashed = await run([step], {
      hooks: { beforeRecord: () => "crash" },
    });
    expect(crashed.crashed).toBe(true);
    expect(read(out)).toBe("x");

    const next = await run([step]);
    expect(next.recovered).toEqual([
      {
        staging: path.join(migratingRoot(home), "7-two-phase"),
        action: "undone",
      },
    ]);
    expect(next).toMatchObject({ partial: [7], failed: null });
    expect(read(out)).toBe("x");
  });
});
