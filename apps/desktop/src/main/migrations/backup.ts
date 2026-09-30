/**
 * Backups, file moves and the filesystem seam for the migration commit
 * protocol (spec 00 C.1).
 *
 * A step's backups live in `<home>/backups/migrations/<stamp>_<attempt>-<id>-<name>/`,
 * mirroring each file's path under the home (`home/…`), else under userData
 * (`userData/…`), else its absolute path (`abs/…`). Quarantined sources
 * (C.5) live in `<home>/backups/quarantine/<kind>/`: a freshly written copy
 * aged by its mtime (step 4), or a `<stamp>/` run directory aged by its
 * stamp (for anything moved in, since a move keeps the source's mtime).
 *
 * Every filesystem call the runner, the journal and the backups make goes
 * through a `MigrationIo`, so the crash harness (`runner.crash.test.ts`) can
 * stop the process at each mutation and prove the next launch recovers.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export const MIGRATING_DIR_NAME = ".migrating";

export const migratingRoot = (home: string): string =>
  path.join(home, MIGRATING_DIR_NAME);

export const backupsRoot = (home: string): string =>
  path.join(home, "backups", "migrations");

export const quarantineRoot = (home: string): string =>
  path.join(home, "backups", "quarantine");

/**
 * Where a step quarantines one run's files of `kind` (C.5, step 4). The
 * stamped directory is what the 90-day pruning ages.
 */
export const quarantineDirFor = (
  home: string,
  kind: string,
  stamp: string
): string => path.join(quarantineRoot(home), kind, stamp);

/** `20260930T121314123Z`: sortable, and safe in a file name everywhere. */
export const formatStamp = (date: Date): string =>
  date.toISOString().replace(/[-:.]/g, "");

const STAMP = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/;

export const parseStamp = (stamp: string): Date | null => {
  const match = STAMP.exec(stamp);
  if (match == null) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

/**
 * The backup directory's name for one commit attempt:
 * `<stamp>_<attempt>-<id>-<name>`. The attempt keeps two attempts in one
 * millisecond apart; the name still ends in `-<id>-<name>`.
 */
export const backupDirName = (
  commit: string,
  id: number,
  name: string,
  attempt: string
): string => `${commit}_${attempt}-${id}-${name}`;

/** `path.relative` when `file` is strictly inside `root`, else null. */
export const inside = (root: string, file: string): string | null => {
  const relative = path.relative(root, file);
  return relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
    ? relative
    : null;
};

export const backupPathFor = (
  backupDir: string,
  file: string,
  roots: { home: string; userData: string }
): string => {
  const underHome = inside(roots.home, file);
  if (underHome != null) return path.join(backupDir, "home", underHome);
  const underUserData = inside(roots.userData, file);
  if (underUserData != null)
    return path.join(backupDir, "userData", underUserData);
  const { root } = path.parse(file);
  return path.join(
    backupDir,
    "abs",
    root.replace(/[:\\/]/g, ""),
    file.slice(root.length)
  );
};

/**
 * The filesystem as the migration code uses it. Mutations are the calls the
 * crash harness interrupts; reads are never interrupted.
 */
export interface MigrationIo {
  readFileSync(file: string): Buffer;
  readdirSync(dir: string): string[];
  lstatSync(file: string): fs.Stats;
  mkdirSync(dir: string): void;
  writeFileSync(file: string, data: string | Buffer): void;
  appendFileSync(file: string, data: string): void;
  copyFileSync(source: string, dest: string): void;
  renameSync(source: string, dest: string): void;
  /** `rm -f` (a file) or `rm -rf` (`recursive`). */
  rmSync(file: string, options?: { recursive?: boolean }): void;
  rmdirSync(dir: string): void;
}

const RETRYABLE_RENAME = new Set(["EPERM", "EACCES", "EBUSY"]);
const SLEEP = new Int32Array(new SharedArrayBuffer(4));

/**
 * `rename`, retried briefly on Windows, where a virus scanner or indexer
 * holding the file refuses it with EPERM/EACCES/EBUSY (as
 * `writeFileAtomicSync` does).
 */
const renameWithRetry = (source: string, dest: string): void => {
  for (let attempt = 1; ; attempt++) {
    try {
      fs.renameSync(source, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? "";
      if (
        process.platform !== "win32" ||
        !RETRYABLE_RENAME.has(code) ||
        attempt >= 4
      )
        throw error;
      Atomics.wait(SLEEP, 0, 0, 10 * attempt);
    }
  }
};

export const nodeIo: MigrationIo = {
  readFileSync: (file) => fs.readFileSync(file),
  readdirSync: (dir) => fs.readdirSync(dir),
  lstatSync: (file) => fs.lstatSync(file),
  mkdirSync: (dir) => {
    fs.mkdirSync(dir, { recursive: true });
  },
  writeFileSync: (file, data) => fs.writeFileSync(file, data),
  appendFileSync: (file, data) => fs.appendFileSync(file, data),
  copyFileSync: (source, dest) => fs.copyFileSync(source, dest),
  renameSync: renameWithRetry,
  rmSync: (file, options) =>
    fs.rmSync(file, { force: true, recursive: options?.recursive === true }),
  rmdirSync: (dir) => fs.rmdirSync(dir),
};

export const errorCode = (error: unknown): string | undefined =>
  (error as NodeJS.ErrnoException | null)?.code;

/** Absent (and only absent): anything else is an error the caller sees. */
export const isAbsentError = (error: unknown): boolean =>
  errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR";

/**
 * Whether `file` exists. Only genuine absence is `false`: an unreadable
 * path (EACCES, EIO) throws, so no decision is taken on a guess.
 */
export const exists = (file: string, io: MigrationIo = nodeIo): boolean => {
  try {
    io.lstatSync(file);
    return true;
  } catch (error) {
    if (isAbsentError(error)) return false;
    throw error;
  }
};

export const sha256File = (file: string, io: MigrationIo = nodeIo): string =>
  createHash("sha256").update(io.readFileSync(file)).digest("hex");

/** The temp name `copyFileAtomic` publishes `dest` through. */
export const temporaryFor = (dest: string): string => `${dest}.migrating-tmp`;

/**
 * Copy through a temp name and rename, so `dest` is never half written. The
 * temp name is fixed (the single-instance lock rules out a second writer),
 * so a crash's leftover is found and swept by the next recovery.
 */
export const copyFileAtomic = (
  source: string,
  dest: string,
  io: MigrationIo = nodeIo
): void => {
  io.mkdirSync(path.dirname(dest));
  const temporary = temporaryFor(dest);
  io.copyFileSync(source, temporary);
  io.renameSync(temporary, dest);
};

/** Writes `data` through a temp name and a rename. */
export const writeFileAtomic = (
  file: string,
  data: string,
  io: MigrationIo = nodeIo
): void => {
  io.mkdirSync(path.dirname(file));
  const temporary = temporaryFor(file);
  io.writeFileSync(temporary, data);
  io.renameSync(temporary, file);
};

/**
 * `rename`, atomic within a volume (staging sits under the home for exactly
 * that reason). Across volumes (a userData elsewhere) it copies atomically
 * and then removes the source; a crash between the two leaves both, which
 * recovery handles without asking which happened (see `journal.ts`).
 */
export const moveFile = (
  source: string,
  dest: string,
  io: MigrationIo = nodeIo
): void => {
  io.mkdirSync(path.dirname(dest));
  try {
    io.renameSync(source, dest);
  } catch (error) {
    if (errorCode(error) !== "EXDEV") throw error;
    copyFileAtomic(source, dest, io);
    io.rmSync(source);
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;

/** Stamp, optional attempt (older names have none), step id, step name. */
const BACKUP_DIR = /^(\d{8}T\d{9}Z)(?:_[0-9a-f]+)?-(\d+)-(.+)$/;
const PRUNING_PREFIX = ".pruning-";

export interface PruneOptions {
  now: Date;
  /**
   * Backup directory names the record points at (applied commits). Only
   * these count toward the newest-per-step limit; any other directory (an
   * undone or abandoned attempt) is kept until it is `maxAgeDays` old.
   * Omitted: every backup directory counts (the runner always passes it).
   */
  referenced?: ReadonlySet<string>;
  /** Backups older than this go (30 days). */
  maxAgeDays?: number;
  /** Per step, only the newest this many applied commits keep theirs (3). */
  keepPerStep?: number;
  /** Quarantine runs older than this go (90 days). */
  quarantineDays?: number;
  io?: MigrationIo;
}

const readdirOrEmpty = (dir: string, io: MigrationIo): string[] => {
  try {
    return io.readdirSync(dir);
  } catch (error) {
    if (isAbsentError(error)) return [];
    throw error;
  }
};

/**
 * Deletes a directory by renaming it out of its valid name first, so a
 * crash part way leaves a `.pruning-*` name (swept next time), never a
 * partial backup under a name the manual rollback would trust.
 */
const removeTree = (
  parent: string,
  name: string,
  io: MigrationIo,
  removed: string[]
): void => {
  const target = path.join(parent, name);
  const doomed = path.join(parent, `${PRUNING_PREFIX}${name}`);
  io.renameSync(target, doomed);
  io.rmSync(doomed, { recursive: true });
  removed.push(target);
};

/**
 * Backups past 30 days, and applied commits' backups beyond the newest 3 per
 * step; quarantine runs past 90 days. Must only run when no commit attempt
 * is unresolved (the runner's rule), since an unresolved journal may point
 * at a backup no record references. Returns what was removed.
 */
export const pruneBackups = (home: string, options: PruneOptions): string[] => {
  const io = options.io ?? nodeIo;
  const removed: string[] = [];
  const now = options.now.getTime();
  const maxAge = (options.maxAgeDays ?? 30) * DAY_MS;
  const keep = options.keepPerStep ?? 3;

  const root = backupsRoot(home);
  const names = readdirOrEmpty(root, io);
  for (const name of names)
    if (name.startsWith(PRUNING_PREFIX))
      io.rmSync(path.join(root, name), { recursive: true });

  const byStep = new Map<string, { name: string; at: number }[]>();
  for (const name of names) {
    const match = BACKUP_DIR.exec(name);
    const at = match == null ? null : parseStamp(match[1] ?? "");
    if (match == null || at == null) continue;
    if (now - at.getTime() > maxAge) {
      removeTree(root, name, io, removed);
      continue;
    }
    if (options.referenced != null && !options.referenced.has(name)) continue;
    const list = byStep.get(match[2] ?? "") ?? [];
    list.push({ name, at: at.getTime() });
    byStep.set(match[2] ?? "", list);
  }
  for (const list of byStep.values()) {
    list.sort((a, b) => b.at - a.at);
    for (const entry of list.slice(keep))
      removeTree(root, entry.name, io, removed);
  }

  const quarantineAge = (options.quarantineDays ?? 90) * DAY_MS;
  const quarantine = quarantineRoot(home);
  for (const kind of readdirOrEmpty(quarantine, io)) {
    const directory = path.join(quarantine, kind);
    let runs: string[];
    try {
      runs = readdirOrEmpty(directory, io);
    } catch {
      continue;
    }
    for (const run of runs) {
      if (run.startsWith(PRUNING_PREFIX)) {
        io.rmSync(path.join(directory, run), { recursive: true });
        continue;
      }
      // A stamped run directory is aged by its stamp. A single file is aged
      // by its mtime, which is the quarantine time only because step 4
      // writes a fresh copy into staging (a plain move would keep the
      // source's mtime and must use `quarantineDirFor` instead).
      let at = parseStamp(run)?.getTime() ?? null;
      if (at == null) {
        try {
          at = io.lstatSync(path.join(directory, run)).mtimeMs;
        } catch {
          continue;
        }
      }
      if (now - at <= quarantineAge) continue;
      removeTree(directory, run, io, removed);
    }
  }
  return removed;
};
