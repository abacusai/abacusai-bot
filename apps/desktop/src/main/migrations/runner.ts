import { randomBytes } from "node:crypto";
import path from "node:path";

/**
 * The one-time, versioned migration runner (spec 00 C.1). Runs in main
 * inside `whenReady`, after the single-instance lock and before any service
 * reads the files it migrates.
 *
 * On launch it first settles every attempt a previous launch left in
 * `.migrating/` (see "Recovery" below). Then each step not yet in
 * `migrations.json` runs in ascending id: it plans (staging every output),
 * then the runner commits the plan:
 * 1. back up every `replace-user` destination (with its hash);
 * 2. write `commit.journal` (the plan and a unique attempt id) once;
 * 3. move each staged file onto its destination and each removal into the
 *    backup directory, appending a `done` line to `commit.log` after each,
 *    and yielding to the event loop every `yieldEvery` moves;
 * 4. append the record entry (with the attempt id), then a `recorded` line;
 * 5. delete the staging, journal first.
 *
 * Recovery, per staging directory, after reading and validating every
 * journal (nothing is touched before):
 * - no journal: the attempt died before committing; staging is discarded;
 * - the attempt is recorded (record entry with its step and attempt, or a
 *   `recorded` log line): it finished; staging is discarded;
 * - otherwise it is rolled back (`rollback`), then the journal is deleted,
 *   then its backups, then the staging. Once the journal is gone the
 *   attempt is over, so a crash after that leaves only an orphan backup;
 * - a journal that is unreadable or invalid, or a rollback that fails, or a
 *   record that cannot be trusted to judge it: the attempt is **unresolved**.
 *   Its files are kept as they are, no step runs, and `unresolved` lists the
 *   destinations it may cover (null: unknown, so all) so startup can keep
 *   writers off them (`isWriteBlocked`). The app still starts.
 *
 * A failure in this launch is recorded as `lastFailure` and stops the run;
 * the next launch retries from that step. `runMigrations` never throws.
 * Applied steps are never rolled back automatically.
 */
import {
  completeAttempt,
  completedAttempts,
  rebuildRestoreIndex,
  writeAttemptManifest,
} from "./attempt-records";
import {
  backupDirName,
  backupPathFor,
  backupsRoot,
  copyFileAtomic,
  exists,
  formatStamp,
  isAbsentError,
  migratingRoot,
  moveFile,
  nodeIo,
  pruneBackups,
  sha256File,
  type MigrationIo,
} from "./backup";
import {
  appendLog,
  destinationsOf,
  isDestination,
  JOURNAL_VERSION,
  journalFile,
  logFile,
  readJournal,
  rollback,
  writeJournal,
  type CommitJournal,
  type JournalLog,
} from "./journal";
import {
  backupOf,
  recordsAttempt,
  readRecordState,
  setAsideCorruptRecord,
  writeRecord,
  type AppliedMigration,
  type MigrationRecord,
} from "./record";
import type { MigrationContext, MigrationPlan, MigrationStep } from "./types";

/**
 * Test seams for the commit. Throwing is a failure in this launch (undone
 * at once); returning `"crash"` stops the runner dead, as a `SIGKILL` would,
 * leaving the journal and staging for the next launch. The filesystem-level
 * crash harness (`runner.crash.test.ts`) uses `io` instead.
 */
export interface CommitHooks {
  /** After the `index`th write's move (0-based) and its log line. */
  afterMove?: (index: number, dest: string) => void | "crash";
  /** After every move, before the record entry. */
  beforeRecord?: () => void | "crash";
  /** After the record entry, before the staging is deleted. */
  afterRecord?: () => void | "crash";
}

export interface RunMigrationsOptions {
  home: string;
  userData: string;
  appVersion: string;
  steps: readonly MigrationStep[];
  /** Ids to run again (`--rerun-migration`, unpackaged), after recovery. */
  rerun?: readonly number[];
  now?: () => Date;
  log?: (message: string) => void;
  /** Overall progress across the steps that run. */
  onProgress?: (done: number, total: number, label: string) => void;
  hooks?: CommitHooks;
  /** The filesystem (tests inject crashes and cross-volume renames). */
  io?: MigrationIo;
  /** A fresh id per commit attempt (tests only). */
  attemptId?: () => string;
  /** Moves between event-loop yields during a commit or rollback (20). */
  yieldEvery?: number;
}

export interface UnresolvedAttempt {
  staging: string;
  id: number | null;
  name: string | null;
  /**
   * Every path the attempt may have changed, or null when that is unknown
   * (the journal cannot be read), which blocks every destination.
   */
  destinations: string[] | null;
  error: string;
}

export interface RunMigrationsResult {
  /** Ids committed and recorded in this run. */
  applied: number[];
  /** Ids committed in this run with work left (`plan.pending`): not recorded. */
  partial: number[];
  failed: { id: number; name: string; error: string } | null;
  /** Staging directories found on launch, with what was done to them. */
  recovered: {
    staging: string;
    action: "undone" | "discarded" | "finished";
  }[];
  /**
   * Attempts left as found because recovering them was not safe. While any
   * is listed, writers must stay off its destinations (`isWriteBlocked`).
   */
  unresolved: UnresolvedAttempt[];
  /** The record was written by a newer build: nothing ran or was written. */
  skipped?: "newer-record";
  /** A hook asked for a simulated crash (tests only). */
  crashed?: boolean;
}

/**
 * Whether `file` may be covered by an unresolved commit. A writer that
 * finds it blocked must not write it this launch (the next launch's
 * rollback could otherwise overwrite that write, or be defeated by it).
 */
export const isWriteBlocked = (
  result: Pick<RunMigrationsResult, "unresolved"> | null,
  file: string
): boolean => {
  if (result == null) return false;
  const target = path.resolve(file);
  return result.unresolved.some(
    (attempt) =>
      attempt.destinations == null || attempt.destinations.includes(target)
  );
};

class SimulatedCrash extends Error {}

/** Share of a step's progress given to `plan()`; the commit gets the rest. */
const PLAN_SHARE = 0.8;

/**
 * Partial commits in a row whose `pending` did not go down before the step
 * is recorded as applied as it stands (so a step never reruns forever).
 */
export const MAX_STALLED_PARTIALS = 2;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stagingFor = (home: string, step: MigrationStep): string =>
  path.join(migratingRoot(home), `${step.id}-${step.name}`);

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

const STAGING_NAME = /^(\d+)-([a-z0-9-]+)$/;

export const runMigrations = async (
  options: RunMigrationsOptions
): Promise<RunMigrationsResult> => {
  const io = options.io ?? nodeIo;
  const now = options.now ?? (() => new Date());
  const newAttempt =
    options.attemptId ?? (() => randomBytes(8).toString("hex"));
  const yieldEvery = Math.max(1, options.yieldEvery ?? 20);
  const log =
    options.log ??
    ((message: string) => console.log(`[migrations] ${message}`));
  const result: RunMigrationsResult = {
    applied: [],
    partial: [],
    failed: null,
    recovered: [],
    unresolved: [],
  };
  const { home, userData } = options;

  const removeStaging = (staging: string): void => {
    // The journal goes first: staging without a journal is only discarded.
    io.rmSync(journalFile(staging));
    io.rmSync(staging, { recursive: true });
  };

  const recordState = readRecordState(home, io);
  /** Null while the record cannot be trusted or written. */
  let record: MigrationRecord | null =
    recordState.status === "ok" || recordState.status === "missing"
      ? recordState.record
      : null;

  const fail = (
    step: { id: number; name: string },
    error: unknown
  ): RunMigrationsResult => {
    const message = errorMessage(error);
    log(`step ${step.id} ${step.name} failed: ${message}`);
    result.failed = { id: step.id, name: step.name, error: message };
    if (record == null) return result;
    record.lastFailure = {
      id: step.id,
      name: step.name,
      at: now().toISOString(),
      error: message,
    };
    try {
      writeRecord(home, record, io);
    } catch (writeError) {
      log(`cannot record the failure: ${errorMessage(writeError)}`);
    }
    return result;
  };

  // ── Recovery ─────────────────────────────────────────────────────────
  let entries: string[] = [];
  try {
    entries = io.readdirSync(migratingRoot(home)).sort();
  } catch (error) {
    if (!isAbsentError(error))
      result.unresolved.push({
        staging: migratingRoot(home),
        id: null,
        name: null,
        destinations: null,
        error: `cannot list: ${errorMessage(error)}`,
      });
  }

  // Read and validate everything before touching anything.
  const inspected = entries.map((entry) => {
    const staging = path.join(migratingRoot(home), entry);
    const named = STAGING_NAME.exec(entry);
    return {
      staging,
      id: named == null ? null : Number(named[1]),
      name: named == null ? null : (named[2] ?? null),
      read: readJournal({ home, userData, staging }, io),
    };
  });

  if (recordState.status === "newer") {
    // A later build's record: judge nothing, write nothing.
    log(
      `migrations.json is version ${recordState.version}, newer than this build; running nothing`
    );
    result.skipped = "newer-record";
    for (const attempt of inspected)
      if (attempt.read.status !== "missing")
        result.unresolved.push({
          staging: attempt.staging,
          id: attempt.id,
          name: attempt.name,
          destinations:
            attempt.read.status === "ok"
              ? destinationsOf(attempt.read.journal)
              : null,
          error: "left for the newer build",
        });
    return result;
  }

  const unresolve = (
    attempt: (typeof inspected)[number],
    destinations: string[] | null,
    error: string
  ) => {
    log(`${path.basename(attempt.staging)}: unresolved, kept: ${error}`);
    result.unresolved.push({
      staging: attempt.staging,
      id: attempt.id,
      name: attempt.name,
      destinations,
      error,
    });
  };

  for (const attempt of inspected) {
    const { staging, read } = attempt;
    const entry = path.basename(staging);
    if (read.status === "missing") {
      try {
        removeStaging(staging);
      } catch (error) {
        log(`cannot delete ${staging}: ${errorMessage(error)}`);
      }
      result.recovered.push({ staging, action: "discarded" });
      continue;
    }
    if (read.status !== "ok") {
      unresolve(attempt, null, `${read.status} journal: ${read.error}`);
      continue;
    }
    const { journal } = read;
    const finished =
      read.log.recorded ||
      (record != null && recordsAttempt(record, journal.id, journal.attempt));
    if (finished) {
      // Only the staging's deletion was cut short.
      try {
        // Older journals predate retained records; they remain recoverable.
        if (exists(path.join(journal.backupDir, "attempt.json"), io)) {
          const partial =
            record?.partial?.some(
              (entry) => entry.attempt === journal.attempt
            ) ?? false;
          completeAttempt(
            journal.backupDir,
            journal.attempt,
            partial,
            now().toISOString(),
            io
          );
        }
        removeStaging(staging);
      } catch (error) {
        unresolve(
          attempt,
          destinationsOf(journal),
          `completion failed: ${errorMessage(error)}`
        );
        continue;
      }
      result.recovered.push({ staging, action: "finished" });
      continue;
    }
    if (record == null) {
      unresolve(
        attempt,
        destinationsOf(journal),
        `the record is ${recordState.status}, so whether this commit finished is unknown`
      );
      continue;
    }
    try {
      const undone = await undo(staging, journal, read.log);
      log(
        `${entry}: undid an interrupted commit (restored ${undone.restored.length}, deleted ${undone.deleted.length}, kept ${undone.kept.length})`
      );
      result.recovered.push({ staging, action: "undone" });
    } catch (error) {
      unresolve(
        attempt,
        destinationsOf(journal),
        `rollback failed: ${errorMessage(error)}`
      );
    }
  }

  if (result.unresolved.length > 0) {
    const first = result.unresolved[0];
    return fail(
      { id: first?.id ?? 0, name: first?.name ?? "recovery" },
      new Error(`recovery failed: ${first?.error ?? "unknown"}`)
    );
  }

  if (recordState.status === "unreadable")
    return fail(
      { id: 0, name: "record" },
      new Error(`cannot read migrations.json: ${recordState.error}`)
    );
  if (recordState.status === "corrupt") {
    try {
      const aside = setAsideCorruptRecord(home, now(), io);
      log(
        `migrations.json is corrupt (${recordState.error}); kept as ${aside}`
      );
    } catch (error) {
      return fail({ id: 0, name: "record" }, error);
    }
    record = { version: 1, applied: [] };
  }
  // Non-null from here: missing, ok, or a corrupt one set aside.
  let current: MigrationRecord = record ?? { version: 1, applied: [] };
  record = current;

  // `--rerun-migration`, only now that every attempt is settled.
  if (options.rerun != null && options.rerun.length > 0) {
    const rerun = new Set(options.rerun);
    const before = current.applied.length;
    const next = {
      ...current,
      applied: current.applied.filter((entry) => !rerun.has(entry.id)),
    };
    if (next.applied.length !== before) {
      try {
        writeRecord(home, next, io);
      } catch (error) {
        return fail({ id: 0, name: "record" }, error);
      }
      current = next;
      record = current;
      log(`rerunning ${[...rerun].join(", ")}`);
    }
  }

  // ── Steps ────────────────────────────────────────────────────────────
  const appliedIds = new Set(current.applied.map((entry) => entry.id));
  const pending = [...options.steps]
    .sort((a, b) => a.id - b.id)
    .filter((step) => !appliedIds.has(step.id));

  for (const [index, step] of pending.entries()) {
    const attempt = newAttempt();
    const staging = stagingFor(home, step);
    const started = Date.now();
    const fraction = (share: number, label?: string) => {
      options.onProgress?.(
        index * 1000 + Math.round(Math.min(1, Math.max(0, share)) * 1000),
        pending.length * 1000,
        label ?? step.name
      );
    };
    const report = (done: number, total: number, label?: string) => {
      fraction(total > 0 ? (done / total) * PLAN_SHARE : 0, label);
    };

    let plan: MigrationPlan;
    try {
      removeStaging(staging);
      io.mkdirSync(staging);
      const context: MigrationContext = {
        attempt,
        home,
        userData,
        appVersion: options.appVersion,
        staging,
        progress: report,
        log: (message) => log(`${step.id} ${step.name}: ${message}`),
      };
      report(0, 1);
      plan = await step.plan(context);
      validatePlan(plan, staging, { home, userData }, io);
    } catch (error) {
      try {
        removeStaging(staging);
      } catch (cleanupError) {
        log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
      }
      return fail(step, error);
    }

    const commit = formatStamp(now());
    const backupName = backupDirName(commit, step.id, step.name, attempt);
    const journal: CommitJournal = {
      version: JOURNAL_VERSION,
      attempt,
      id: step.id,
      name: step.name,
      commit,
      backupDir: path.join(backupsRoot(home), backupName),
      writes: [],
      removals: [],
    };
    let journaled = false;
    let partial = false;
    try {
      // 1. Back up what may hold data found nowhere else.
      const roots = { home, userData };
      for (const write of plan.writes) {
        const present = exists(write.dest, io);
        // A `create` whose destination appeared since the plan is treated as
        // user data: never replaced without a copy. A `replace-user` whose
        // destination is gone has nothing to keep.
        const kind =
          write.kind === "create" && present
            ? "replace-user"
            : write.kind === "replace-user" && !present
              ? "create"
              : write.kind;
        if (kind !== "replace-user") {
          journal.writes.push({
            ...write,
            kind,
            backup: null,
            originalHash: null,
            stagedHash: null,
          });
          continue;
        }
        const backup = backupPathFor(journal.backupDir, write.dest, roots);
        const originalHash = sha256File(write.dest, io);
        copyFileAtomic(write.dest, backup, io);
        if (sha256File(backup, io) !== originalHash)
          throw new Error(`${write.dest} changed while it was backed up`);
        journal.writes.push({
          ...write,
          kind,
          backup,
          originalHash,
          stagedHash: sha256File(write.staged, io),
        });
      }
      for (const removal of plan.removals) {
        if (!exists(removal, io)) continue;
        journal.removals.push({
          path: removal,
          backup: backupPathFor(journal.backupDir, removal, roots),
        });
      }
      // 2. The journal, once.
      writeJournal(staging, journal, io);
      journaled = true;
      writeAttemptManifest(journal, roots, io);
      // 3. Moves, each followed by an appended `done`.
      const total = journal.writes.length + journal.removals.length;
      let moved = 0;
      const progressed = async () => {
        moved += 1;
        if (moved % yieldEvery === 0) {
          fraction(PLAN_SHARE + (1 - PLAN_SHARE) * (moved / total));
          await tick();
        }
      };
      for (const [i, write] of journal.writes.entries()) {
        moveFile(write.staged, write.dest, io);
        appendLog(
          staging,
          attempt,
          { op: "done", target: "write", index: i },
          io
        );
        if (options.hooks?.afterMove?.(i, write.dest) === "crash")
          throw new SimulatedCrash();
        await progressed();
      }
      for (const [i, removal] of journal.removals.entries()) {
        moveFile(removal.path, removal.backup, io);
        appendLog(
          staging,
          attempt,
          { op: "done", target: "removal", index: i },
          io
        );
        await progressed();
      }
      if (options.hooks?.beforeRecord?.() === "crash")
        throw new SimulatedCrash();
      // 4. The record, then its mark in the log. A plan that left work for
      // the next launch (`pending`) is recorded as a partial commit: final
      // (never rolled back), but the step is not applied, so it runs again.
      // A step whose pending work stops going down is applied as it stands
      // after `MAX_STALLED_PARTIALS` such commits, so it never reruns
      // forever (what it could not do stays where it was, untouched).
      const pending = plan.pending ?? 0;
      const others = (current.partial ?? []).filter(
        (entry) => entry.id !== step.id
      );
      const previous = current.partial?.find((entry) => entry.id === step.id);
      const stalled =
        pending > 0 && previous != null && pending >= previous.pending
          ? previous.stalled + 1
          : 0;
      partial = pending > 0 && stalled < MAX_STALLED_PARTIALS;
      const next: MigrationRecord = { ...current };
      if (partial) {
        next.partial = [
          ...others,
          {
            id: step.id,
            name: step.name,
            at: now().toISOString(),
            commit,
            attempt,
            backup: backupName,
            pending,
            stalled,
          },
        ];
      } else {
        if (pending > 0)
          log(
            `${step.id} ${step.name}: ${pending} left after ${stalled + 1} commits without progress; recording it as applied`
          );
        const entry: AppliedMigration = {
          id: step.id,
          name: step.name,
          appliedAt: now().toISOString(),
          appVersion: options.appVersion,
          durationMs: Date.now() - started,
          stats:
            pending > 0 ? { ...plan.stats, pendingLeft: pending } : plan.stats,
          commit,
          attempt,
          backup: backupName,
        };
        next.applied = [...current.applied, entry];
        if (others.length > 0) next.partial = others;
        else delete next.partial;
      }
      if (next.lastFailure?.id === step.id) delete next.lastFailure;
      writeRecord(home, next, io);
      current = next;
      record = current;
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        result.crashed = true;
        return result;
      }
      // Undo at once, as the next launch would.
      if (journaled) {
        try {
          // The same rollback as the next launch's: it does not depend on
          // `done`, and nothing has been undone yet.
          await undo(staging, journal, {
            done: new Set(),
            undone: new Set(),
            recorded: false,
          });
        } catch (undoError) {
          log(
            `undo of ${step.id} ${step.name} failed, left for the next launch: ${errorMessage(undoError)}`
          );
          result.unresolved.push({
            staging,
            id: step.id,
            name: step.name,
            destinations: destinationsOf(journal),
            error: `rollback failed: ${errorMessage(undoError)}`,
          });
        }
      } else {
        try {
          // Nothing was moved: only copies were made.
          io.rmSync(journal.backupDir, { recursive: true });
          removeStaging(staging);
        } catch (cleanupError) {
          log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
        }
      }
      return fail(step, error);
    }

    // The record is the commit point. Completion failure must never undo it.
    try {
      completeAttempt(
        journal.backupDir,
        attempt,
        partial,
        now().toISOString(),
        io
      );
    } catch (error) {
      result.unresolved.push({
        staging,
        id: step.id,
        name: step.name,
        destinations: destinationsOf(journal),
        error: errorMessage(error),
      });
      return fail(step, error);
    }
    // 5. The staging. A failure here is finished on the next launch.
    try {
      appendLog(staging, attempt, { op: "recorded" }, io);
      if (options.hooks?.afterRecord?.() === "crash") {
        result.crashed = true;
        return result;
      }
      removeStaging(staging);
    } catch (error) {
      log(`cannot delete ${staging}: ${errorMessage(error)}`);
    }
    fraction(1);
    (partial ? result.partial : result.applied).push(step.id);
    log(
      `${partial ? `committed with ${plan.pending} left for the next launch:` : "applied"} ${step.id} ${step.name} in ${Date.now() - started} ms ${JSON.stringify(plan.stats)}`
    );
    if (partial) {
      log(
        `stopping after pending step ${step.id}; later steps wait for the next launch`
      );
      break;
    }
  }

  // ── Housekeeping, on every launch that got here without a failure ─────
  try {
    io.rmdirSync(migratingRoot(home));
  } catch {
    // Not empty (a staging we could not delete) or already gone.
  }
  try {
    rebuildRestoreIndex(home, io, log);
    const retained = new Set(
      completedAttempts(home, io, log)
        .filter(({ manifest }) => {
          const applied = current.applied.find(
            (entry) => entry.id === manifest.step
          );
          return (
            applied === undefined ||
            now().getTime() - Date.parse(applied.appliedAt) <= 30 * 86400000
          );
        })
        .map(({ directory }) => path.basename(directory))
    );
    const pruned = pruneBackups(home, {
      retained,
      now: now(),
      referenced: new Set([
        ...current.applied.map(backupOf),
        ...(current.partial ?? []).map((entry) => entry.backup),
      ]),
      io,
    });
    if (pruned.length > 0) {
      log(`pruned ${pruned.length} old backups`);
      rebuildRestoreIndex(home, io, log);
    }
  } catch (error) {
    log(`pruning failed: ${errorMessage(error)}`);
  }
  return result;

  /**
   * Rolls an attempt back, then ends it: the journal is deleted before its
   * backups, so no crash can leave a journal whose backups are gone.
   */
  async function undo(
    staging: string,
    journal: CommitJournal,
    journalLog: JournalLog
  ) {
    const undone = await rollback({
      staging,
      journal,
      log: journalLog,
      io,
      yieldEvery,
      note: (message) => log(`${path.basename(staging)}: ${message}`),
    });
    io.rmSync(journalFile(staging));
    try {
      io.rmSync(journal.backupDir, { recursive: true });
      io.rmSync(staging, { recursive: true });
    } catch (error) {
      // The attempt is over; what is left is an orphan, pruned by age.
      log(`cannot delete ${staging} or its backups: ${errorMessage(error)}`);
    }
    return undone;
  }
};

/**
 * Every staged file exists inside the step's staging, once; every
 * destination and removal is under the home or userData, once.
 */
const validatePlan = (
  plan: MigrationPlan,
  staging: string,
  roots: { home: string; userData: string },
  io: MigrationIo
): void => {
  if (
    plan == null ||
    !Array.isArray(plan.writes) ||
    !Array.isArray(plan.removals)
  )
    throw new Error("the step returned no plan");
  const reserved = new Set([journalFile(staging), logFile(staging)]);
  const touched = new Set<string>();
  const staged = new Set<string>();
  for (const write of plan.writes) {
    const inStaging = path.relative(staging, write.staged);
    if (
      inStaging === "" ||
      inStaging.startsWith("..") ||
      path.isAbsolute(inStaging) ||
      reserved.has(write.staged) ||
      !exists(write.staged, io)
    )
      throw new Error(`staged file ${write.staged} is not in the staging`);
    if (staged.has(write.staged))
      throw new Error(`staged file ${write.staged} is used twice`);
    staged.add(write.staged);
    if (!isDestination(write.dest, roots))
      throw new Error(
        `destination ${write.dest} is not under the home or userData`
      );
    if (touched.has(write.dest))
      throw new Error(`destination ${write.dest} is written twice`);
    touched.add(write.dest);
  }
  for (const removal of plan.removals) {
    if (!isDestination(removal, roots) || touched.has(removal))
      throw new Error(
        `removal ${removal} is not under the home or userData, or is also written`
      );
    touched.add(removal);
  }
};
