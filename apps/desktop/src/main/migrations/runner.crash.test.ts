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

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { backupsRoot, migratingRoot, nodeIo, type MigrationIo } from "./backup";
import { readRecord } from "./record";
import { runMigrations, type RunMigrationsOptions } from "./runner";
import type { MigrationStep } from "./types";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: {},
}));
import { transcriptsV2 } from "./steps/001-transcripts-v2";
import { finalLegacyPrefs } from "./steps/003-final-legacy-prefs";
import { archiveTranscriptsV1 } from "./steps/004-archive-transcripts-v1";

class Killed extends Error {}

/** Kills attempted in this file (`REPORT_KILLS=1` prints the total). */
let killPoints = 0;
afterAll(() => {
  if (process.env.REPORT_KILLS === "1")
    console.log(`[crash harness] ${killPoints} kill points`);
});

/** Every file under `dir`, depth first. */
const filesUnder = (dir: string): string[] => {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries.flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? filesUnder(full) : [full];
  });
};

const removeHalf = (dir: string): void => {
  const all = filesUnder(dir);
  for (const file of all.slice(0, Math.ceil(all.length / 2)))
    fs.rmSync(file, { force: true });
};

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
  if (Number.isFinite(killAt)) killPoints += 1;
  const rel = (file: string) =>
    path.relative(root, file).split(path.sep).join("/");
  const volume = (file: string) => rel(file).split("/")[0];
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
      mutate(
        `rm ${rel(file)}`,
        () => nodeIo.rmSync(file, options),
        // A recursive delete killed part way: about half its files are gone.
        options?.recursive === true ? () => removeHalf(file) : undefined
      ),
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

/**
 * The filesystem the fixture steps plan through: the launch's harness, so a
 * kill can also land in step planning (staged writes), not only in the
 * runner's own calls.
 */
let planIo: MigrationIo = nodeIo;

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
        planIo.writeFileSync(staged, content);
        return { dest, staged, kind };
      }),
      removals: [f.transcript, f.legacy],
      stats: {},
    };
  },
};

const run = (steps: MigrationStep[], extra: Partial<RunMigrationsOptions>) => {
  planIo = extra.io ?? nodeIo;
  return runMigrations({
    home,
    userData,
    appVersion: "1.0.0",
    steps,
    log: () => undefined,
    now: () => new Date("2026-09-30T12:00:00.000Z"),
    ...extra,
  });
};

/** The user-visible files: everything but the runner's own bookkeeping. */
const userState = (): Record<string, string> => {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join("/");
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

    it("a recovery killed at any point is finished by the next launch", async () => {
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
        await crash();
        const where = `kill ${killAt} at "${ops[killAt - 1]}"`;
        const h = harness(root, killAt, crossVolume);
        await run([], { io: h.io });
        expect(h.killed(), where).toBe(true);
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
    });
  }
);

// ── Matrices over states, from snapshots ───────────────────────────────────

const snapshots: string[] = [];

afterEach(() => {
  for (const snap of snapshots.splice(0))
    fs.rmSync(snap, { recursive: true, force: true });
});

/** The whole temp root, set aside (mtimes kept) to restore before each kill. */
const snapshot = (): string => {
  const snap = fs.mkdtempSync(path.join(os.tmpdir(), "migrations-snap-"));
  snapshots.push(snap);
  fs.cpSync(root, snap, { recursive: true, preserveTimestamps: true });
  return snap;
};

const restore = (snap: string): void => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.cpSync(snap, root, { recursive: true, preserveTimestamps: true });
};

/**
 * From `snap`, runs `launch` once cleanly to list its mutations, then once
 * per mutation with a kill there, asserting each intended kill fired, and
 * hands the killed state to `check`. Returns the mutation list.
 */
const everyKill = async (
  snap: string,
  crossVolume: boolean,
  launch: (io: MigrationIo) => Promise<unknown>,
  check: (where: string, op: string, killAt: number) => Promise<void>
): Promise<string[]> => {
  restore(snap);
  const clean = harness(root, Infinity, crossVolume);
  await launch(clean.io);
  const ops = [...clean.ops];
  for (let killAt = 1; killAt <= ops.length; killAt++) {
    restore(snap);
    const h = harness(root, killAt, crossVolume);
    await launch(h.io);
    const where = `kill ${killAt}/${ops.length} at "${ops[killAt - 1]}"`;
    expect(h.killed(), where).toBe(true);
    await check(where, ops[killAt - 1] ?? "", killAt);
  }
  return ops;
};

const cleanIo = (crossVolume: boolean) =>
  harness(root, Infinity, crossVolume).io;

/** Launches with `steps` until nothing is pending (at most `max`). */
const settle = async (
  steps: MigrationStep[],
  crossVolume: boolean,
  where: string,
  max = 4
) => {
  for (let launch = 0; launch < max; launch++) {
    const result = await run(steps, { io: cleanIo(crossVolume) });
    expect(result.unresolved, where).toEqual([]);
    expect(result.failed, where).toBeNull();
    if (result.applied.length === 0 && result.partial.length === 0) return;
  }
  throw new Error(`${where}: still running steps after ${max} launches`);
};

const isTorn = (file: string): boolean => {
  const text = fs.readFileSync(file, "utf8");
  return text !== "" && !text.endsWith("\n");
};

// Harness operations use portable paths; path.join accepts this on every OS.
const LOG = "1-everything/commit.log";

describe.each([
  ["same volume", false],
  ["cross volume (EXDEV)", true],
])(
  "recovery from torn log tails, %s",
  { timeout: 600_000 },
  (_, crossVolume) => {
    it("every commit append torn, every recovery kill from there, and every kill of the recovery after that", async () => {
      setup();
      const origin = snapshot();
      const commitOps = await cleanOps(crossVolume);
      const recordRename = commitOps.findIndex(
        (op) => op.startsWith("rename ") && op.endsWith("home/migrations.json")
      );
      // Torn `done` lines: every append before the record is published.
      const tornAt = commitOps
        .map((op, index) => ({ op, killAt: index + 1 }))
        .filter(
          ({ op, killAt }) =>
            op.endsWith(LOG) &&
            op.startsWith("append ") &&
            killAt <= recordRename
        );
      expect(tornAt.length).toBeGreaterThan(3);
      let tornRollbacks = 0;

      for (const { killAt } of tornAt) {
        restore(origin);
        const h = harness(root, killAt, crossVolume);
        await run([step], { io: h.io });
        expect(h.killed()).toBe(true);
        const log = path.join(migratingRoot(home), LOG);
        expect(isTorn(log), `commit kill ${killAt}`).toBe(true);
        const torn = snapshot();

        const recoveryOps = await everyKill(
          torn,
          crossVolume,
          (io) => run([], { io }),
          async (where, op) => {
            // The interrupted recovery's state, and every kill of the next.
            const interrupted = snapshot();
            if (op.startsWith("append ") && op.endsWith(LOG))
              tornRollbacks += 1;
            // The second level runs same-volume only: the cross-volume
            // moves are covered one level down, and the product is large.
            const nextOps = crossVolume
              ? []
              : await everyKill(
                  interrupted,
                  crossVolume,
                  (io) => run([], { io }),
                  async (whereNext) => {
                    const final = await run([], { io: cleanIo(crossVolume) });
                    expect(final.unresolved, `${where}; ${whereNext}`).toEqual(
                      []
                    );
                    expectRolledBack(userState());
                  }
                );
            // A torn rollback line is trimmed before the next append.
            if (!crossVolume && op.startsWith("append ") && op.endsWith(LOG))
              expect(
                nextOps.some((next) =>
                  next.startsWith(`write home/.migrating/${LOG}.migrating-tmp`)
                ),
                where
              ).toBe(true);
            restore(interrupted);
            const final = await run([], { io: cleanIo(crossVolume) });
            expect(final.unresolved, where).toEqual([]);
            expectRolledBack(userState());
          }
        );
        // Recovery from a torn commit tail trims it first (write + rename).
        expect(recoveryOps).toContain(
          `write home/.migrating/${LOG}.migrating-tmp`
        );
        expect(recoveryOps).toContain(
          `rename home/.migrating/${LOG}.migrating-tmp -> home/.migrating/${LOG}`
        );
      }
      expect(tornRollbacks).toBeGreaterThan(0);
    });
  }
);

// ── Other runner branches (same volume; the moves are covered above) ───────

/** A step with a create and a replace-user write; `pending` from the state. */
const twoPhase = (pending: () => number): MigrationStep => ({
  id: 7,
  name: "two-phase",
  plan: async (ctx) => {
    const staged = path.join(ctx.staging, "0.out");
    const user = path.join(ctx.staging, "1.out");
    const round = readRecord(home).partial?.length ?? 0;
    planIo.writeFileSync(staged, `OUT ${round}`);
    planIo.writeFileSync(user, "PREFS-NEW");
    return {
      writes: [
        {
          dest: path.join(home, "threads", "out.json"),
          staged,
          kind: "create",
        },
        { dest: files().prefs, staged: user, kind: "replace-user" },
      ],
      removals: [],
      stats: {},
      pending: pending(),
    };
  },
});

const hasPartial = () =>
  (readRecord(home).partial ?? []).some((entry) => entry.id === 7);

describe(
  "kill matrices over the other runner branches",
  { timeout: 600_000 },
  () => {
    it("publishing a partial (pending) commit", async () => {
      setup();
      const pstep = twoPhase(() => (hasPartial() ? 0 : 1));
      const snap = snapshot();
      const ops = await everyKill(
        snap,
        false,
        (io) => run([pstep], { io }),
        async (where) => {
          // The next launch settles it: rolled back, or final as partial.
          const next = await run([], { io: cleanIo(false) });
          expect(next.unresolved, where).toEqual([]);
          if (hasPartial())
            expect(fs.readFileSync(files().prefs, "utf8")).toBe("PREFS-NEW");
          else
            expect(fs.readFileSync(files().prefs, "utf8"), where).toBe(
              "PREFS-OLD"
            );
          await settle([pstep], false, where);
          const record = readRecord(home);
          expect(
            record.applied.filter((entry) => entry.id === 7),
            where
          ).toHaveLength(1);
          expect(record.partial, where).toBeUndefined();
        }
      );
      expect(ops.some((op) => op.endsWith("home/migrations.json"))).toBe(true);
    });

    it("the stall cap's completion", async () => {
      setup();
      const stuck = twoPhase(() => 1);
      await run([stuck], {});
      await run([stuck], {});
      expect(readRecord(home).partial).toMatchObject([{ id: 7, stalled: 1 }]);
      const snap = snapshot();
      await everyKill(
        snap,
        false,
        (io) => run([stuck], { io }),
        async (where) => {
          await settle([stuck], false, where);
          const record = readRecord(home);
          expect(
            record.applied.filter((entry) => entry.id === 7),
            where
          ).toHaveLength(1);
          expect(record.applied[0]?.stats, where).toMatchObject({
            pendingLeft: 1,
          });
          expect(record.partial, where).toBeUndefined();
          // And it never runs again.
          const again = await run([stuck], {});
          expect(again, where).toMatchObject({ applied: [], partial: [] });
        }
      );
    });

    it("preserving a corrupt record", async () => {
      setup();
      fs.writeFileSync(path.join(home, "migrations.json"), "{torn record");
      const snap = snapshot();
      const ops = await everyKill(
        snap,
        false,
        (io) => run([step], { io }),
        async (where) => {
          await settle([step], false, where);
          expect(userState(), where).toEqual(COMMITTED);
          const kept = fs
            .readdirSync(home)
            .filter((name) => name.startsWith("migrations.json"))
            .map((name) => fs.readFileSync(path.join(home, name), "utf8"));
          expect(kept, where).toContain("{torn record");
          expect(
            readRecord(home).applied.filter((e) => e.id === 1),
            where
          ).toHaveLength(1);
        }
      );
      expect(ops[0]).toMatch(
        /^rename home\/migrations\.json -> home\/migrations\.json\.corrupt-/
      );
    });

    it("publishing a --rerun-migration record", async () => {
      setup();
      await run([step], {});
      const snap = snapshot();
      const ops = await everyKill(
        snap,
        false,
        (io) => run([step], { io, rerun: [1] }),
        async (where) => {
          await settle([step], false, where);
          expect(userState(), where).toEqual(COMMITTED);
          expect(
            readRecord(home).applied.filter((e) => e.id === 1),
            where
          ).toHaveLength(1);
        }
      );
      // The rerun's own record write comes first (mkdir, write, rename).
      expect(ops.slice(0, 3)).toEqual([
        "mkdir home",
        "write home/migrations.json.migrating-tmp",
        "rename home/migrations.json.migrating-tmp -> home/migrations.json",
      ]);
    });

    it("pruning, .pruning-* leftovers, and a recursive delete killed part way", async () => {
      setup();
      const now = new Date("2026-09-30T12:00:00.000Z");
      const day = 24 * 60 * 60 * 1000;
      const stamp = (daysAgo: number) =>
        new Date(now.getTime() - daysAgo * day)
          .toISOString()
          .replace(/[-:.]/g, "");
      const backups = backupsRoot(home);
      const dir = (name: string) => {
        for (const file of [
          "home/a.json",
          "home/deep/b.json",
          "userData/c.json",
        ]) {
          fs.mkdirSync(path.dirname(path.join(backups, name, file)), {
            recursive: true,
          });
          fs.writeFileSync(path.join(backups, name, file), name);
        }
        return name;
      };
      const applied = [1, 2, 3, 4, 5].map((days) =>
        dir(`${stamp(days)}_${String(days).padStart(16, "0")}-1-a`)
      );
      const orphanOld = dir(`${stamp(40)}_${"d".repeat(16)}-1-a`);
      const orphanNew = dir(`${stamp(1)}_${"c".repeat(16)}-1-a`);
      const leftover = dir(`.pruning-${stamp(2)}_${"e".repeat(16)}-1-a`);
      const quarantine = path.join(
        home,
        "backups",
        "quarantine",
        "transcripts"
      );
      const oldRun = path.join(quarantine, stamp(100));
      const newRun = path.join(quarantine, stamp(1));
      for (const run_ of [oldRun, newRun]) {
        fs.mkdirSync(run_, { recursive: true });
        fs.writeFileSync(path.join(run_, "t1.json"), "q");
        fs.writeFileSync(path.join(run_, "t2.json"), "q");
      }
      fs.writeFileSync(
        path.join(home, "migrations.json"),
        JSON.stringify({
          version: 1,
          applied: applied.map((backup, index) => ({
            id: 1,
            name: "a",
            appliedAt: "",
            appVersion: "",
            durationMs: 0,
            stats: {},
            commit: backup.slice(0, 19),
            attempt: String(index + 1).padStart(16, "0"),
            backup,
          })),
        })
      );
      const snap = snapshot();
      const expected = [...applied.slice(0, 3), orphanNew].sort();
      const ops = await everyKill(
        snap,
        false,
        (io) => run([], { io }),
        async (where) => {
          const next = await run([], {});
          expect(next.failed, where).toBeNull();
          expect(
            fs
              .readdirSync(backups)
              .filter((name) => name !== "restore-index.jsonl")
              .sort(),
            where
          ).toEqual(expected);
          // What is kept is whole.
          for (const name of expected)
            expect(filesUnder(path.join(backups, name)), where).toHaveLength(3);
          expect(fs.existsSync(oldRun), where).toBe(false);
          expect(filesUnder(newRun), where).toHaveLength(2);
        }
      );
      // Deletion goes through a rename out of the valid name.
      expect(ops).toContain(`rm home/backups/migrations/${leftover}`);
      expect(
        ops.some((op) =>
          op.includes(`-> home/backups/migrations/.pruning-${orphanOld}`)
        )
      ).toBe(true);
      expect(
        ops.some((op) =>
          op.includes(
            `${stamp(100)} -> home/backups/quarantine/transcripts/.pruning-`
          )
        )
      ).toBe(true);
    });
  }
);

for (const crossVolume of [false, true]) {
  it(`R7-T14: real steps 3 and 4 recover at every runner mutation (EXDEV=${crossVolume})`, async () => {
    fs.mkdirSync(userData, { recursive: true });
    fs.mkdirSync(path.join(home, "transcripts"), { recursive: true });
    fs.writeFileSync(
      path.join(userData, "renderer-state.json"),
      JSON.stringify({ theme: "dark", unmapped: "keep" })
    );
    fs.writeFileSync(
      path.join(home, "transcripts", "s.json"),
      JSON.stringify({
        version: 1,
        sessionId: "s",
        updatedAt: "2026-09-01T00:00:00.000Z",
        segments: [
          { type: "text", id: "u", source: "user", content: "synthetic" },
        ],
      })
    );
    await run([transcriptsV2()], {});
    const snap = snapshot();
    const steps = [finalLegacyPrefs(), archiveTranscriptsV1()];
    const result = await run(steps, {});
    expect(result.failed).toBeNull();
    const expected = userState();
    await everyKill(
      snap,
      crossVolume,
      (io) => run(steps, { io }),
      async (where) => {
        await settle(steps, crossVolume, where);
        const actual = userState();
        // Attempt ids and timestamps are regenerated after a rolled-back retirement.
        for (const state of [actual, expected]) {
          const retired = state["userdata/renderer-state.retired.json"];
          if (retired !== undefined) {
            const parsed = JSON.parse(retired);
            delete parsed.attempt;
            delete parsed.at;
            state["userdata/renderer-state.retired.json"] =
              JSON.stringify(parsed);
          }
          const prefs = state["home/prefs.json"];
          if (prefs !== undefined) {
            const parsed = JSON.parse(prefs);
            parsed.row.updatedAt = "masked";
            state["home/prefs.json"] = JSON.stringify(parsed);
          }
        }
        expect(actual, where).toEqual(expected);
      }
    );
  });
}
