/**
 * The one-time, versioned migration runner (spec 00 C.1). Runs in main
 * inside `whenReady`, after the single-instance lock and before any service
 * reads the files it migrates.
 *
 * Each step not yet in `migrations.json` runs in ascending id: it plans
 * (staging every output), then the runner commits the plan:
 * 1. back up every `replace-user` destination;
 * 2. write `commit.journal` into staging;
 * 3. rename each staged file onto its destination, and move each removal
 *    into the backup directory, appending to the journal's `done` each time;
 * 4. append the record entry;
 * 5. delete the staging, journal first.
 *
 * On launch, a journal left in `.migrating/` means a commit died part way:
 * it is undone (`undoCommit`) and the step runs again. Staging without a
 * journal died before committing and is just deleted. A failure in this
 * launch is recorded as `lastFailure` and stops the run; the next launch
 * retries from that step. Failure never blocks launch: `runMigrations`
 * never throws. Applied steps are never rolled back automatically.
 */
import fs from "node:fs";
import path from "node:path";

import {
  backupPathFor,
  backupsRoot,
  exists,
  formatStamp,
  migratingRoot,
  moveFile,
  copyFileAtomic,
  pruneBackups,
} from "./backup";
import {
  journalFile,
  readJournal,
  undoCommit,
  writeJournal,
  type CommitJournal,
} from "./journal";
import {
  readRecord,
  writeRecord,
  type AppliedMigration,
  type MigrationRecord,
} from "./record";
import type { MigrationContext, MigrationPlan, MigrationStep } from "./types";

/**
 * Test seams for the commit. Throwing is a failure in this launch (undone
 * at once); returning `"crash"` stops the runner dead, as a `SIGKILL` would,
 * leaving the journal and staging for the next launch.
 */
export interface CommitHooks {
  /** After the `index`th rename (0-based) and its journal update. */
  afterRename?: (index: number, dest: string) => void | "crash";
  /** After every rename, before the record entry. */
  beforeRecord?: () => void | "crash";
}

export interface RunMigrationsOptions {
  home: string;
  userData: string;
  appVersion: string;
  steps: readonly MigrationStep[];
  /** Ids to take out of `applied` first (`--rerun-migration`, unpackaged). */
  rerun?: readonly number[];
  now?: () => Date;
  log?: (message: string) => void;
  /** Overall progress across the steps that run. */
  onProgress?: (done: number, total: number, label: string) => void;
  hooks?: CommitHooks;
}

export interface RunMigrationsResult {
  /** Ids committed and recorded in this run. */
  applied: number[];
  /** Ids committed in this run with work left (`plan.pending`): not recorded. */
  partial: number[];
  failed: { id: number; name: string; error: string } | null;
  /** Staging directories found on launch, with what was done to them. */
  recovered: { staging: string; action: "undone" | "discarded" | "finished" }[];
  /** A hook asked for a simulated crash (tests only). */
  crashed?: boolean;
}

class SimulatedCrash extends Error {}

/** A committed plan with `pending` work: not recorded, so it runs again. */
class Deferred extends Error {}

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const stagingFor = (home: string, step: MigrationStep): string =>
  path.join(migratingRoot(home), `${step.id}-${step.name}`);

const removeStaging = (staging: string): void => {
  // The journal goes first: staging without a journal is only ever discarded.
  fs.rmSync(journalFile(staging), { force: true });
  fs.rmSync(staging, { recursive: true, force: true });
};

const isInside = (root: string, file: string): boolean => {
  const relative = path.relative(root, file);
  return (
    relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
  );
};

export const runMigrations = async (
  options: RunMigrationsOptions
): Promise<RunMigrationsResult> => {
  const now = options.now ?? (() => new Date());
  const log =
    options.log ??
    ((message: string) => console.log(`[migrations] ${message}`));
  const result: RunMigrationsResult = {
    applied: [],
    partial: [],
    failed: null,
    recovered: [],
  };
  const { home } = options;

  let record: MigrationRecord;
  try {
    record = readRecord(home);
    if (options.rerun != null && options.rerun.length > 0) {
      const rerun = new Set(options.rerun);
      const before = record.applied.length;
      record.applied = record.applied.filter((entry) => !rerun.has(entry.id));
      if (record.applied.length !== before) {
        writeRecord(home, record);
        log(`rerunning ${[...rerun].join(", ")}`);
      }
    }
  } catch (error) {
    log(`cannot read or write the record: ${errorMessage(error)}`);
    result.failed = { id: 0, name: "record", error: errorMessage(error) };
    return result;
  }

  const fail = (
    step: Pick<MigrationStep, "id" | "name">,
    error: unknown
  ): RunMigrationsResult => {
    const message = errorMessage(error);
    log(`step ${step.id} ${step.name} failed: ${message}`);
    result.failed = { id: step.id, name: step.name, error: message };
    record.lastFailure = {
      id: step.id,
      name: step.name,
      at: now().toISOString(),
      error: message,
    };
    try {
      writeRecord(home, record);
    } catch (writeError) {
      log(`cannot record the failure: ${errorMessage(writeError)}`);
    }
    return result;
  };

  // Recovery: a previous launch that died with a step in flight.
  let entries: string[] = [];
  try {
    entries = fs.readdirSync(migratingRoot(home));
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    const staging = path.join(migratingRoot(home), entry);
    const journal = readJournal(staging);
    try {
      if (journal === "missing" || journal === "corrupt") {
        if (journal === "corrupt")
          log(`${entry}: unreadable commit journal; discarding its staging`);
        removeStaging(staging);
        result.recovered.push({ staging, action: "discarded" });
        continue;
      }
      if (record.applied.some((applied) => applied.commit === journal.commit)) {
        // Recorded: only the staging's deletion was cut short.
        removeStaging(staging);
        result.recovered.push({ staging, action: "finished" });
        continue;
      }
      const undone = undoCommit(journal);
      log(
        `${entry}: undid an interrupted commit (restored ${undone.restored.length}, deleted ${undone.deleted.length}, kept ${undone.kept.length})`
      );
      fs.rmSync(journal.backupDir, { recursive: true, force: true });
      removeStaging(staging);
      result.recovered.push({ staging, action: "undone" });
    } catch (error) {
      // Leave the journal for the next launch; running the step again now
      // would reset the staging it lives in.
      const step =
        journal === "missing" || journal === "corrupt"
          ? { id: 0, name: entry }
          : { id: journal.id, name: journal.name };
      return fail(step, new Error(`recovery failed: ${errorMessage(error)}`));
    }
  }

  const appliedIds = new Set(record.applied.map((entry) => entry.id));
  const pending = [...options.steps]
    .sort((a, b) => a.id - b.id)
    .filter((step) => !appliedIds.has(step.id));
  if (pending.length === 0) return result;

  for (const [index, step] of pending.entries()) {
    const staging = stagingFor(home, step);
    const started = Date.now();
    const report = (done: number, total: number, label?: string) => {
      const fraction = total > 0 ? Math.min(1, Math.max(0, done / total)) : 0;
      options.onProgress?.(
        index * 1000 + Math.round(fraction * 1000),
        pending.length * 1000,
        label ?? step.name
      );
    };

    let plan: MigrationPlan;
    try {
      removeStaging(staging);
      fs.mkdirSync(staging, { recursive: true });
      const context: MigrationContext = {
        home,
        userData: options.userData,
        appVersion: options.appVersion,
        staging,
        progress: report,
        log: (message) => log(`${step.id} ${step.name}: ${message}`),
      };
      report(0, 1);
      plan = await step.plan(context);
      validatePlan(plan, staging);
    } catch (error) {
      try {
        removeStaging(staging);
      } catch (cleanupError) {
        log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
      }
      return fail(step, error);
    }

    const commit = formatStamp(now());
    const journal: CommitJournal = {
      version: 1,
      id: step.id,
      name: step.name,
      commit,
      backupDir: path.join(
        backupsRoot(home),
        `${commit}-${step.id}-${step.name}`
      ),
      writes: [],
      removals: [],
      done: [],
    };
    let journaled = false;
    try {
      // 1. Back up what may hold data found nowhere else.
      const roots = { home, userData: options.userData };
      for (const write of plan.writes) {
        const present = exists(write.dest);
        // A `create` whose destination appeared since the plan is treated
        // as user data: never replaced without a copy.
        const kind =
          write.kind === "create" && present ? "replace-user" : write.kind;
        let backup: string | null = null;
        if (kind === "replace-user" && present) {
          backup = backupPathFor(journal.backupDir, write.dest, roots);
          copyFileAtomic(write.dest, backup);
        }
        journal.writes.push({ ...write, kind, backup });
      }
      for (const removal of plan.removals) {
        if (!exists(removal)) continue;
        journal.removals.push({
          path: removal,
          backup: backupPathFor(journal.backupDir, removal, roots),
        });
      }
      // 2. The journal.
      writeJournal(staging, journal);
      journaled = true;
      // 3. Renames and removals.
      let renamed = 0;
      for (const write of journal.writes) {
        moveFile(write.staged, write.dest);
        journal.done.push(write.dest);
        writeJournal(staging, journal);
        if (options.hooks?.afterRename?.(renamed, write.dest) === "crash")
          throw new SimulatedCrash();
        renamed += 1;
      }
      for (const removal of journal.removals) {
        moveFile(removal.path, removal.backup);
        journal.done.push(removal.path);
        writeJournal(staging, journal);
      }
      if (options.hooks?.beforeRecord?.() === "crash")
        throw new SimulatedCrash();
      // 4. The record, unless the step left work for the next launch: then
      // it runs again, and a journal left by a crash is undone as usual.
      if ((plan.pending ?? 0) > 0) throw new Deferred();
      const entry: AppliedMigration = {
        id: step.id,
        name: step.name,
        appliedAt: now().toISOString(),
        appVersion: options.appVersion,
        durationMs: Date.now() - started,
        stats: plan.stats,
        commit,
      };
      const next: MigrationRecord = {
        ...record,
        applied: [...record.applied, entry],
      };
      if (next.lastFailure?.id === step.id) delete next.lastFailure;
      writeRecord(home, next);
      record = next;
    } catch (error) {
      if (error instanceof SimulatedCrash) {
        result.crashed = true;
        return result;
      }
      if (error instanceof Deferred) {
        try {
          removeStaging(staging);
        } catch (cleanupError) {
          log(`cannot delete ${staging}: ${errorMessage(cleanupError)}`);
        }
        report(1, 1);
        result.partial.push(step.id);
        log(
          `committed ${step.id} ${step.name} with ${plan.pending} left for the next launch ${JSON.stringify(plan.stats)}`
        );
        continue;
      }
      // Undo at once, as the next launch would.
      try {
        if (journaled) undoCommit(journal);
        fs.rmSync(journal.backupDir, { recursive: true, force: true });
        removeStaging(staging);
      } catch (undoError) {
        log(
          `undo of ${step.id} ${step.name} failed, left for the next launch: ${errorMessage(undoError)}`
        );
      }
      return fail(step, error);
    }

    // 5. The staging. A failure here is finished on the next launch.
    try {
      removeStaging(staging);
    } catch (error) {
      log(`cannot delete ${staging}: ${errorMessage(error)}`);
    }
    report(1, 1);
    result.applied.push(step.id);
    log(
      `applied ${step.id} ${step.name} in ${Date.now() - started} ms ${JSON.stringify(plan.stats)}`
    );
  }

  try {
    fs.rmdirSync(migratingRoot(home));
  } catch {
    // Not empty (a staging we could not delete) or already gone.
  }
  try {
    const pruned = pruneBackups(home, { now: now() });
    if (pruned.length > 0) log(`pruned ${pruned.length} old backups`);
  } catch (error) {
    log(`pruning failed: ${errorMessage(error)}`);
  }
  return result;
};

/** Every staged file must exist inside the step's staging. */
const validatePlan = (plan: MigrationPlan, staging: string): void => {
  if (
    plan == null ||
    !Array.isArray(plan.writes) ||
    !Array.isArray(plan.removals)
  )
    throw new Error("the step returned no plan");
  const dests = new Set<string>();
  for (const write of plan.writes) {
    if (!isInside(staging, write.staged) || !exists(write.staged))
      throw new Error(`staged file ${write.staged} is not in the staging`);
    if (!path.isAbsolute(write.dest))
      throw new Error(`destination ${write.dest} is not absolute`);
    if (dests.has(write.dest))
      throw new Error(`destination ${write.dest} is written twice`);
    dests.add(write.dest);
  }
  for (const removal of plan.removals) {
    if (!path.isAbsolute(removal) || dests.has(removal))
      throw new Error(`removal ${removal} is not absolute or is also written`);
  }
};
