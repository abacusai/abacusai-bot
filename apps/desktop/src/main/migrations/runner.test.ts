/**
 * C-T3: the migration runner against a temp home and userData. Order,
 * idempotence, the record written only after the commit, plan failures,
 * commit recovery from the journal (in this launch and the next), rerun and
 * pruning.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  backupsRoot,
  formatStamp,
  migratingRoot,
  quarantineRoot,
} from "./backup";
import { JOURNAL_NAME, type CommitJournal } from "./journal";
import { readRecord, recordFile } from "./record";
import { runMigrations, type RunMigrationsOptions } from "./runner";
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
    expect(first).toMatchObject({ applied: [1, 2], failed: null });
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
    expect(fs.existsSync(migratingRoot(home))).toBe(false);

    const second = await run(steps);
    expect(second).toMatchObject({ applied: [], failed: null });
    expect(calls).toEqual(["first", "second"]);
  });

  it("writes the record only after every rename", async () => {
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

  it("refuses a plan whose staged file is outside the staging", async () => {
    const outside = path.join(root, "outside");
    fs.writeFileSync(outside, "x");
    const result = await run([
      {
        id: 1,
        name: "bad",
        plan: async () => ({
          writes: [
            { dest: path.join(home, "x"), staged: outside, kind: "create" },
          ],
          removals: [],
          stats: {},
        }),
      },
    ]);
    expect(result.failed?.error).toMatch(/not in the staging/);
    expect(fs.existsSync(path.join(home, "x"))).toBe(false);
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

    it("a crash after the first of three renames is undone on the next launch", async () => {
      const { user, created, derived, step } = setupThree();

      const crashed = await run([step], {
        hooks: { afterRename: (index) => (index === 0 ? "crash" : undefined) },
      });
      expect(crashed.crashed).toBe(true);
      expect(read(user)).toBe("USER-NEW");
      const staging = path.join(migratingRoot(home), "1-three");
      const journal = JSON.parse(
        fs.readFileSync(path.join(staging, JOURNAL_NAME), "utf8")
      ) as CommitJournal;
      expect(journal.done).toEqual([user]);
      expect(readRecord(home).applied).toEqual([]);

      // Next launch: recovery puts the user file back (seen here with no
      // steps registered), then the step runs again from scratch.
      const recovery = await run([]);
      expect(recovery.recovered).toEqual([{ staging, action: "undone" }]);
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

    it("undoes every kind by its rule when the crash follows all renames", async () => {
      const { user, created, derived, step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-NEW",
        "CREATED",
        "DERIVED-NEW",
      ]);

      // Recovery only: a step list without it shows the undone state.
      const recovered = await run([]);
      expect(recovered.recovered[0]?.action).toBe("undone");
      expect(read(user)).toBe("USER-ORIGINAL");
      expect(read(created)).toBeNull();
      // Derived data is left: it is correct or will be regenerated.
      expect(read(derived)).toBe("DERIVED-NEW");
      expect(fs.readdirSync(migratingRoot(home))).toEqual([]);
    });

    it("a failure after all renames but before the record reruns to an identical result", async () => {
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
          afterRename: (index) => {
            if (index === 1) throw new Error("EIO");
          },
        },
      });
      expect(result.failed).toMatchObject({ id: 1, error: "EIO" });
      expect([read(user), read(created), read(derived)]).toEqual([
        "USER-ORIGINAL",
        null,
        "DERIVED-OLD",
      ]);
      expect(fs.existsSync(path.join(migratingRoot(home), "1-three"))).toBe(
        false
      );
      expect(readRecord(home).lastFailure?.id).toBe(1);
    });

    it("undoes a rename the journal missed (staged file gone)", async () => {
      const { user, step } = setupThree();
      await run([step], {
        hooks: { afterRename: (index) => (index === 0 ? "crash" : undefined) },
      });
      const staging = path.join(migratingRoot(home), "1-three");
      const journalPath = path.join(staging, JOURNAL_NAME);
      const journal = JSON.parse(
        fs.readFileSync(journalPath, "utf8")
      ) as CommitJournal;
      // Died between the rename and the journal update.
      fs.writeFileSync(journalPath, JSON.stringify({ ...journal, done: [] }));

      await run([]);
      expect(read(user)).toBe("USER-ORIGINAL");
    });

    it("finishes a recorded commit whose staging survived, without undoing it", async () => {
      const a = path.join(home, "a.json");
      fs.writeFileSync(a, "OLD");
      const step = fileStep(1, "one", () => [
        { dest: a, content: "NEW", kind: "replace-user" },
      ]);
      await run([step]);
      const commit = readRecord(home).applied[0]?.commit ?? "";
      const staging = path.join(migratingRoot(home), "1-one");
      fs.mkdirSync(staging, { recursive: true });
      const journal: CommitJournal = {
        version: 1,
        id: 1,
        name: "one",
        commit,
        backupDir: path.join(backupsRoot(home), "nope"),
        writes: [
          {
            dest: a,
            staged: path.join(staging, "0.out"),
            kind: "replace-user",
            backup: null,
          },
        ],
        removals: [],
        done: [a],
      };
      fs.writeFileSync(
        path.join(staging, JOURNAL_NAME),
        JSON.stringify(journal)
      );

      const result = await run([step]);
      expect(result.recovered).toEqual([{ staging, action: "finished" }]);
      expect(read(a)).toBe("NEW");
    });

    it("discards staging without a journal or with a corrupt one", async () => {
      const bare = path.join(migratingRoot(home), "7-bare");
      const corrupt = path.join(migratingRoot(home), "8-corrupt");
      fs.mkdirSync(bare, { recursive: true });
      fs.mkdirSync(corrupt, { recursive: true });
      fs.writeFileSync(path.join(bare, "0.out"), "x");
      fs.writeFileSync(path.join(corrupt, JOURNAL_NAME), "{half");

      const result = await run([]);
      expect(result.recovered.map((entry) => entry.action)).toEqual([
        "discarded",
        "discarded",
      ]);
      expect(fs.readdirSync(migratingRoot(home))).toEqual([]);
    });

    it("stops, keeping the journal, when recovery cannot restore a backup", async () => {
      const { step } = setupThree();
      await run([step], { hooks: { beforeRecord: () => "crash" } });
      fs.rmSync(backupsRoot(home), { recursive: true, force: true });
      const calls: string[] = [];

      const result = await run([
        step,
        fileStep(2, "later", () => [], { calls }),
      ]);
      expect(result.failed?.error).toMatch(/recovery failed/);
      expect(calls).toEqual([]);
      expect(
        fs.existsSync(path.join(migratingRoot(home), "1-three", JOURNAL_NAME))
      ).toBe(true);
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
    expect(tree(path.join(backupsRoot(home), dir ?? ""))).toEqual({
      [path.join("home", "electron", "state.json")]: "MINE",
    });
  });

  it("treats a missing or corrupt record as nothing applied", async () => {
    const calls: string[] = [];
    const step = fileStep(1, "one", () => [], { calls });
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(recordFile(home), "{nope");
    await run([step]);
    expect(calls).toEqual(["one"]);
    expect(readRecord(home).applied).toHaveLength(1);
  });

  it("--rerun-migration takes the id out of applied first", async () => {
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

  it("prunes backups past 30 days or beyond the newest 3 per step, and old quarantine", async () => {
    const now = new Date("2026-09-30T12:00:00.000Z");
    const day = 24 * 60 * 60 * 1000;
    const backups = backupsRoot(home);
    const make = (daysAgo: number, step: string) => {
      const name = `${formatStamp(new Date(now.getTime() - daysAgo * day))}-${step}`;
      fs.mkdirSync(path.join(backups, name), { recursive: true });
      return name;
    };
    const keep = [make(1, "1-a"), make(2, "1-a"), make(3, "1-a")];
    const dropped = [make(4, "1-a"), make(31, "2-b")];
    const kept2 = make(10, "2-b");
    fs.mkdirSync(path.join(backups, "unrelated"), { recursive: true });

    const quarantine = path.join(quarantineRoot(home), "transcripts");
    fs.mkdirSync(quarantine, { recursive: true });
    const oldQ = path.join(quarantine, "old.json");
    const newQ = path.join(quarantine, "new.json");
    fs.writeFileSync(oldQ, "x");
    fs.writeFileSync(newQ, "x");
    const old = new Date(now.getTime() - 91 * day);
    fs.utimesSync(oldQ, old, old);
    await run([fileStep(9, "z", () => [])], { now: () => now });

    const left = fs.readdirSync(backups);
    for (const name of [...keep, kept2, "unrelated"])
      expect(left).toContain(name);
    for (const name of dropped) expect(left).not.toContain(name);
    expect(fs.existsSync(oldQ)).toBe(false);
    expect(fs.existsSync(newQ)).toBe(true);
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
    expect(progress).toContainEqual([500, 2000, "half"]);
    expect(progress.at(-1)).toEqual([2000, 2000, "two"]);
  });
});
