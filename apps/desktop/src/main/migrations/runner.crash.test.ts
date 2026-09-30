/**
 * C-T3, crash windows: a filesystem-level kill harness. Every mutating call
 * the runner makes goes through `MigrationIo`; the harness lets the first
 * `k - 1` through and "kills the process" at the `k`th (a write, append or
 * copy leaves a torn prefix, and every later mutation fails without effect,
 * as nothing runs after a SIGKILL). It does this for every `k` in a full
 * commit, same-volume and cross-volume (EXDEV), for a commit whose in-launch
 * undo is interrupted, and for every `k` in a launch's recovery. After each
 * kill the next launch must settle the attempt with nothing unresolved, and
 * leave the home either exactly as before the commit or exactly as a clean
 * commit leaves it, whichever side of the record's rename the kill fell.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { backupsRoot, migratingRoot, nodeIo, type MigrationIo } from "./backup";
import { readRecord } from "./record";
import { runMigrations, type RunMigrationsOptions } from "./runner";
import type { MigrationStep } from "./types";

class Killed extends Error {}

interface Harness {
  io: MigrationIo;
  /** Every mutation performed, labelled, in order. */
  ops: string[];
  killed: () => boolean;
}

/**
 * `killAt`: the 1-based mutation that never completes (Infinity: none).
 * `crossVolume`: renames between these roots fail with EXDEV.
 */
const harness = (
  root: string,
  killAt: number,
  crossVolume: boolean
): Harness => {
  const ops: string[] = [];
  let count = 0;
  let dead = false;
  const rel = (file: string) => path.relative(root, file);
  const volume = (file: string) => rel(file).split(path.sep)[0];
  const mutate = (
    label: string,
    apply: () => void,
    torn?: () => void
  ): void => {
    if (dead) throw new Killed(`dead: ${label}`);
    count += 1;
    if (count === killAt) {
      dead = true;
      torn?.();
      throw new Killed(label);
    }
    apply();
    ops.push(label);
  };
  const half = (data: string | Buffer) =>
    typeof data === "string"
      ? data.slice(0, Math.floor(data.length / 2))
      : data.subarray(0, Math.floor(data.length / 2));
  const io: MigrationIo = {
    ...nodeIo,
    mkdirSync: (dir) =>
      mutate(`mkdir ${rel(dir)}`, () => nodeIo.mkdirSync(dir)),
    writeFileSync: (file, data) =>
      mutate(
        `write ${rel(file)}`,
        () => nodeIo.writeFileSync(file, data),
        () => fs.writeFileSync(file, half(data))
      ),
    appendFileSync: (file, data) =>
      mutate(
        `append ${rel(file)}`,
        () => nodeIo.appendFileSync(file, data),
        () => fs.appendFileSync(file, half(data))
      ),
    copyFileSync: (source, dest) =>
      mutate(
        `copy ${rel(source)} -> ${rel(dest)}`,
        () => nodeIo.copyFileSync(source, dest),
        () => fs.writeFileSync(dest, half(fs.readFileSync(source)))
      ),
    renameSync: (source, dest) => {
      if (dead) throw new Killed("dead: rename");
      if (crossVolume && volume(source) !== volume(dest))
        throw Object.assign(new Error("EXDEV"), { code: "EXDEV" });
      mutate(`rename ${rel(source)} -> ${rel(dest)}`, () =>
        nodeIo.renameSync(source, dest)
      );
    },
    rmSync: (file, options) =>
      mutate(`rm ${rel(file)}`, () => nodeIo.rmSync(file, options)),
    rmdirSync: (dir) =>
      mutate(`rmdir ${rel(dir)}`, () => nodeIo.rmdirSync(dir)),
  };
  return { io, ops, killed: () => dead };
};

let root: string;
let home: string;
let userData: string;

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-crash-"));
  // Two top-level "volumes": the home, and a userData elsewhere.
  home = path.join(root, "home");
  userData = path.join(root, "userdata");
});

afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

const files = () => ({
  prefs: path.join(home, "prefs.json"),
  created: path.join(home, "threads", "new.json"),
  derived: path.join(home, "threads", "derived.json"),
  state: path.join(userData, "state.json"),
  fresh: path.join(userData, "fresh.json"),
  transcript: path.join(home, "transcripts", "old.json"),
  legacy: path.join(userData, "legacy.txt"),
});

const setup = () => {
  fs.rmSync(root, { recursive: true, force: true });
  const f = files();
  for (const [file, content] of [
    [f.prefs, "PREFS-OLD"],
    [f.derived, "DERIVED-OLD"],
    [f.state, "STATE-OLD"],
    [f.transcript, "V1"],
    [f.legacy, "LEGACY"],
  ] as const) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  }
};

/** Every kind, in both volumes, and removals in both. */
const step: MigrationStep = {
  id: 1,
  name: "everything",
  plan: async (ctx) => {
    const f = files();
    const outputs = [
      [f.prefs, "PREFS-NEW", "replace-user"],
      [f.created, "CREATED", "create"],
      [f.derived, "DERIVED-NEW", "replace-derived"],
      [f.state, "STATE-NEW", "replace-user"],
      [f.fresh, "FRESH", "create"],
    ] as const;
    return {
      writes: outputs.map(([dest, content, kind], index) => {
        const staged = path.join(ctx.staging, `${index}.out`);
        fs.writeFileSync(staged, content);
        return { dest, staged, kind };
      }),
      removals: [f.transcript, f.legacy],
      stats: {},
    };
  },
};

const run = (steps: MigrationStep[], extra: Partial<RunMigrationsOptions>) =>
  runMigrations({
    home,
    userData,
    appVersion: "1.0.0",
    steps,
    log: () => undefined,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    ...extra,
  });

/** The user-visible files: everything but the runner's own bookkeeping. */
const userState = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (
        full === migratingRoot(home) ||
        full === path.join(home, "backups") ||
        entry.name.startsWith("migrations.json")
      )
        continue;
      if (entry.isDirectory()) walk(full);
      else out[rel] = fs.readFileSync(full, "utf8");
    }
  };
  walk(root);
  return out;
};

const ORIGINAL = {
  "home/prefs.json": "PREFS-OLD",
  "home/threads/derived.json": "DERIVED-OLD",
  "home/transcripts/old.json": "V1",
  "userdata/state.json": "STATE-OLD",
  "userdata/legacy.txt": "LEGACY",
};
const COMMITTED = {
  "home/prefs.json": "PREFS-NEW",
  "home/threads/new.json": "CREATED",
  "home/threads/derived.json": "DERIVED-NEW",
  "userdata/state.json": "STATE-NEW",
  "userdata/fresh.json": "FRESH",
};

/** Rolled back: derived data may stay new (C.1), everything else is original. */
const expectRolledBack = (state: Record<string, string>) => {
  const { "home/threads/derived.json": derived, ...rest } = state;
  const { "home/threads/derived.json": _, ...original } = ORIGINAL;
  expect(rest).toEqual(original);
  expect(["DERIVED-OLD", "DERIVED-NEW"]).toContain(derived);
};

/** The applied commit's backup holds every original a manual rollback needs. */
const expectBackup = () => {
  const entry = readRecord(home).applied.find((applied) => applied.id === 1);
  const dir = path.join(backupsRoot(home), entry?.backup ?? "missing");
  const read = (rel: string) => fs.readFileSync(path.join(dir, rel), "utf8");
  expect(read("home/prefs.json")).toBe("PREFS-OLD");
  expect(read("userData/state.json")).toBe("STATE-OLD");
  expect(read("home/transcripts/old.json")).toBe("V1");
  expect(read("userData/legacy.txt")).toBe("LEGACY");
};

/** The clean commit's mutation list (the kill points). */
const cleanOps = async (crossVolume: boolean): Promise<string[]> => {
  setup();
  const h = harness(root, Infinity, crossVolume);
  const result = await run([step], { io: h.io });
  expect(result).toMatchObject({ applied: [1], failed: null });
  expect(userState()).toEqual(COMMITTED);
  return h.ops;
};

describe.each([
  ["same volume", false],
  ["cross volume (EXDEV)", true],
])(
  "kill at every commit transition, %s",
  { timeout: 120_000 },
  (_, crossVolume) => {
    it("the next launch settles the attempt on the right side of the record", async () => {
      const ops = await cleanOps(crossVolume);
      const recordRename = ops.findIndex(
        (op) => op.startsWith("rename ") && op.endsWith("home/migrations.json")
      );
      expect(recordRename).toBeGreaterThan(0);

      // The transitions the review names are all among the kill points.
      const has = (pattern: RegExp) =>
        expect(ops.some((op) => pattern.test(op))).toBe(true);
      has(/^rename home\/backups\/.*\.migrating-tmp -> home\/backups\//);
      has(/^rename .*commit\.journal\.migrating-tmp -> .*commit\.journal$/);
      has(/^append .*commit\.log$/);
      has(/^rename .*\/1-everything\/1\.out -> home\/threads\/new\.json$/);
      has(/^rename home\/transcripts\/old\.json -> home\/backups\//);
      has(/^rm home\/\.migrating\/1-everything\/commit\.journal$/);
      has(/^rm home\/\.migrating\/1-everything$/);
      if (crossVolume) {
        has(
          /^rename userdata\/state\.json\.migrating-tmp -> userdata\/state\.json$/
        );
        has(/^rm home\/\.migrating\/1-everything\/3\.out$/);
        has(/^copy userdata\/legacy\.txt -> home\/backups\//);
        has(/^rm userdata\/legacy\.txt$/);
      }

      for (let killAt = 1; killAt <= ops.length; killAt++) {
        setup();
        const h = harness(root, killAt, crossVolume);
        await run([step], { io: h.io });
        expect(h.killed(), `kill ${killAt}`).toBe(true);
        const recorded = killAt > recordRename + 1;

        // Next launch, recovery only.
        const recovery = await run([], {
          io: harness(root, Infinity, crossVolume).io,
        });
        const where = `kill ${killAt} at "${ops[killAt - 1]}"`;
        expect(recovery.unresolved, where).toEqual([]);
        expect(recovery.failed, where).toBeNull();
        if (recorded) expect(userState(), where).toEqual(COMMITTED);
        else expectRolledBack(userState());
        expect(
          Object.keys(userState()).filter((rel) =>
            rel.endsWith(".migrating-tmp")
          ),
          where
        ).toEqual([]);

        // And the launch after that finishes the step.
        const next = await run([step], {
          io: harness(root, Infinity, crossVolume).io,
        });
        expect(next.failed, where).toBeNull();
        expect(userState(), where).toEqual(COMMITTED);
        expect(
          readRecord(home).applied.filter((applied) => applied.id === 1),
          where
        ).toHaveLength(1);
        expect(fs.existsSync(migratingRoot(home)), where).toBe(false);
        expectBackup();
      }
    });

    it("an in-launch undo killed at any point is finished by the next launch", async () => {
      // A commit that throws after its third move, and whose undo then dies.
      const throwing: Partial<RunMigrationsOptions> = {
        hooks: {
          afterMove: (index) => {
            if (index === 2) throw new Error("EIO");
          },
        },
      };
      setup();
      const clean = harness(root, Infinity, crossVolume);
      const failed = await run([step], { ...throwing, io: clean.io });
      expect(failed.failed?.error).toBe("EIO");
      expectRolledBack(userState());
      const total = clean.ops.length;
      // The undo's own restore is among the kill points.
      expect(
        clean.ops.some((op) =>
          /^rename home\/prefs\.json\.migrating-tmp -> home\/prefs\.json$/.test(
            op
          )
        )
      ).toBe(true);

      for (let killAt = 1; killAt <= total; killAt++) {
        setup();
        const h = harness(root, killAt, crossVolume);
        await run([step], { ...throwing, io: h.io });
        expect(h.killed()).toBe(true);
        const where = `kill ${killAt} at "${clean.ops[killAt - 1]}"`;

        const recovery = await run([], {
          io: harness(root, Infinity, crossVolume).io,
        });
        expect(recovery.unresolved, where).toEqual([]);
        expectRolledBack(userState());
      }
    });

    it("a recovery killed at any point, even twice, is finished by the next launch", async () => {
      // The crash state: every move done, the record not yet written.
      const crash = async () => {
        setup();
        await run([step], {
          io: harness(root, Infinity, crossVolume).io,
          hooks: { beforeRecord: () => "crash" },
        });
      };
      await crash();
      const clean = harness(root, Infinity, crossVolume);
      const recovered = await run([], { io: clean.io });
      expect(recovered.recovered[0]?.action).toBe("undone");
      const ops = clean.ops;
      // The rollback's own transitions are among the kill points.
      const has = (pattern: RegExp) =>
        expect(ops.some((op) => pattern.test(op))).toBe(true);
      has(/^rename home\/prefs\.json\.migrating-tmp -> home\/prefs\.json$/);
      has(/^rm home\/threads\/new\.json$/);
      has(/-> home\/transcripts\/old\.json$/);
      has(/^append .*commit\.log$/);
      const journalRm = ops.findIndex(
        (op) => op.endsWith("commit.journal") && op.startsWith("rm ")
      );
      const backupRm = ops.findIndex((op) =>
        /^rm home\/backups\/migrations\/[^/]+$/.test(op)
      );
      // The journal goes before its backups.
      expect(journalRm).toBeGreaterThanOrEqual(0);
      expect(journalRm).toBeLessThan(backupRm);

      for (let killAt = 1; killAt <= ops.length; killAt++) {
        for (const second of [null, killAt]) {
          await crash();
          const where = `kill ${killAt} at "${ops[killAt - 1]}" then ${second}`;
          await run([], { io: harness(root, killAt, crossVolume).io });
          if (second != null)
            await run([], { io: harness(root, second, crossVolume).io });
          const final = await run([], {
            io: harness(root, Infinity, crossVolume).io,
          });
          expect(final.unresolved, where).toEqual([]);
          expect(final.failed, where).toBeNull();
          expectRolledBack(userState());

          const next = await run([step], {
            io: harness(root, Infinity, crossVolume).io,
          });
          expect(next.applied, where).toEqual([1]);
          expect(userState(), where).toEqual(COMMITTED);
        }
      }
    });
  }
);
