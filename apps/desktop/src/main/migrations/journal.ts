/**
 * The commit journal (spec 00 C.1). Two files in a step's staging:
 *
 * - `commit.journal`: the plan, written once (atomically) before the first
 *   move and never rewritten. It names a unique `attempt`, which the record
 *   entry repeats, so a finished commit is told from an interrupted one by
 *   identity, never by a timestamp.
 * - `commit.log`: append-only, one JSON line per event: a write or removal
 *   `done`, a rollback step `undone`, and `recorded` once the record holds
 *   the attempt. A torn last line (a crash mid-append) is ignored; any other
 *   malformed line makes the journal invalid.
 *
 * Both are validated in full before recovery touches anything. An invalid or
 * unreadable journal is never guessed at: the runner keeps it and blocks
 * writes to whatever it may cover (`runner.ts`).
 *
 * Rollback does not depend on the `done` lines. Every write and removal is
 * put back by a rule that is correct whether or not it happened, and that
 * can be repeated after a crash part way (see `rollback`).
 */
import path from "node:path";

import {
  backupDirName,
  backupPathFor,
  backupsRoot,
  copyFileAtomic,
  exists,
  inside,
  isAbsentError,
  migratingRoot,
  moveFile,
  nodeIo,
  parseStamp,
  sha256File,
  temporaryFor,
  writeFileAtomic,
  type MigrationIo,
} from "./backup";
import { RECORD_FILE_NAME } from "./record";
import type { WriteKind } from "./types";

export const JOURNAL_NAME = "commit.journal";
export const LOG_NAME = "commit.log";
/** 1 was the rewritten-per-move format with a `done` array. */
export const JOURNAL_VERSION = 2;

export interface JournalWrite {
  dest: string;
  staged: string;
  kind: WriteKind;
  /** `replace-user` only: the copy of `dest` taken before the commit. */
  backup: string | null;
  /** `replace-user` only: sha256 of `dest` before the commit (the backup). */
  originalHash: string | null;
  /** `replace-user` only: sha256 of the staged file (what the commit puts). */
  stagedHash: string | null;
}

export interface JournalRemoval {
  path: string;
  /** Where the file is moved; also where recovery finds it. */
  backup: string;
}

export interface CommitJournal {
  version: typeof JOURNAL_VERSION;
  /** Unique per commit attempt; repeated in the record entry. */
  attempt: string;
  id: number;
  name: string;
  /** The commit's stamp (the backup directory's prefix). */
  commit: string;
  backupDir: string;
  writes: JournalWrite[];
  removals: JournalRemoval[];
}

export type LogTarget = "write" | "removal";

export type LogEntry =
  | { op: "done" | "undone"; target: LogTarget; index: number }
  | { op: "recorded" };

export interface JournalLog {
  done: Set<string>;
  undone: Set<string>;
  recorded: boolean;
}

export const logKey = (target: LogTarget, index: number): string =>
  `${target}:${index}`;

export const journalFile = (staging: string): string =>
  path.join(staging, JOURNAL_NAME);

export const logFile = (staging: string): string =>
  path.join(staging, LOG_NAME);

export const writeJournal = (
  staging: string,
  journal: CommitJournal,
  io: MigrationIo = nodeIo
): void => {
  writeFileAtomic(journalFile(staging), JSON.stringify(journal), io);
};

/** Appends one log line for `attempt`. */
export const appendLog = (
  staging: string,
  attempt: string,
  entry: LogEntry,
  io: MigrationIo = nodeIo
): void => {
  io.appendFileSync(
    logFile(staging),
    `${JSON.stringify({ attempt, ...entry })}\n`
  );
};

export interface JournalRoots {
  home: string;
  userData: string;
  /** The staging directory the journal was found in. */
  staging: string;
}

export type JournalRead =
  | { status: "missing" }
  | { status: "unreadable"; error: string }
  | { status: "invalid"; error: string }
  | { status: "ok"; journal: CommitJournal; log: JournalLog };

const ATTEMPT = /^[0-9a-f]{16,64}$/;
const STEP_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SHA256 = /^[0-9a-f]{64}$/;
const KINDS = new Set<WriteKind>(["create", "replace-derived", "replace-user"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

/**
 * Checks every field against what this build would have written for the
 * staging it was found in. Returns the reason it is not, or null.
 */
export const validateJournal = (
  value: unknown,
  roots: JournalRoots
): string | null => {
  if (!isRecord(value)) return "not an object";
  if (value.version !== JOURNAL_VERSION)
    return `unsupported version ${JSON.stringify(value.version)}`;
  const { attempt, id, name, commit, backupDir, writes, removals } = value;
  if (typeof attempt !== "string" || !ATTEMPT.test(attempt))
    return "bad attempt";
  if (typeof id !== "number" || !Number.isInteger(id) || id < 1)
    return "bad id";
  if (typeof name !== "string" || !STEP_NAME.test(name)) return "bad name";
  if (path.basename(roots.staging) !== `${id}-${name}`)
    return "step does not match its staging";
  if (typeof commit !== "string" || parseStamp(commit) == null)
    return "bad commit stamp";
  if (
    backupDir !==
    path.join(backupsRoot(roots.home), backupDirName(commit, id, name, attempt))
  )
    return "bad backup directory";
  if (!Array.isArray(writes) || !Array.isArray(removals))
    return "writes or removals missing";
  const bRoots = { home: roots.home, userData: roots.userData };
  const touched = new Set<string>();
  const staged = new Set<string>();
  for (const write of writes as unknown[]) {
    if (!isRecord(write)) return "bad write";
    if (
      !hasOnly(write, [
        "dest",
        "staged",
        "kind",
        "backup",
        "originalHash",
        "stagedHash",
      ])
    )
      return "unknown write field";
    const { dest, kind, backup, originalHash, stagedHash } = write;
    if (typeof dest !== "string" || !isDestination(dest, bRoots))
      return `bad destination ${String(dest)}`;
    if (
      typeof write.staged !== "string" ||
      inside(roots.staging, write.staged) == null ||
      staged.has(write.staged)
    )
      return `bad staged file for ${dest}`;
    if (typeof kind !== "string" || !KINDS.has(kind as WriteKind))
      return `bad kind for ${dest}`;
    if (kind === "replace-user") {
      if (backup !== backupPathFor(backupDir, dest, bRoots))
        return `bad backup for ${dest}`;
      if (
        typeof originalHash !== "string" ||
        !SHA256.test(originalHash) ||
        typeof stagedHash !== "string" ||
        !SHA256.test(stagedHash)
      )
        return `bad hashes for ${dest}`;
    } else if (backup !== null || originalHash !== null || stagedHash !== null)
      return `unexpected backup for ${dest}`;
    if (touched.has(dest)) return `${dest} is touched twice`;
    touched.add(dest);
    staged.add(write.staged);
  }
  for (const removal of removals as unknown[]) {
    if (!isRecord(removal) || !hasOnly(removal, ["path", "backup"]))
      return "bad removal";
    if (
      typeof removal.path !== "string" ||
      !isDestination(removal.path, bRoots)
    )
      return `bad removal ${String(removal.path)}`;
    if (removal.backup !== backupPathFor(backupDir, removal.path, bRoots))
      return `bad backup for ${removal.path}`;
    if (touched.has(removal.path)) return `${removal.path} is touched twice`;
    touched.add(removal.path);
  }
  return null;
};

/**
 * A migration only ever writes under the home or userData, and never into
 * its own bookkeeping (`.migrating/`, `backups/migrations/`,
 * `migrations.json`). The quarantine (`backups/quarantine/`) is a legitimate
 * destination (step 4).
 */
export const isDestination = (
  file: string,
  roots: { home: string; userData: string }
): boolean =>
  path.isAbsolute(file) &&
  path.normalize(file) === file &&
  (inside(roots.home, file) != null || inside(roots.userData, file) != null) &&
  inside(migratingRoot(roots.home), file) == null &&
  inside(backupsRoot(roots.home), file) == null &&
  file !== path.join(roots.home, RECORD_FILE_NAME);

const parseLog = (
  text: string,
  journal: CommitJournal
): JournalLog | string => {
  const log: JournalLog = {
    done: new Set(),
    undone: new Set(),
    recorded: false,
  };
  const lines = text.split("\n");
  // A complete file ends in "\n", so the last element is "" or a torn line.
  const last = lines.length - 1;
  for (const [index, line] of lines.entries()) {
    if (index === last) break;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      return `malformed log line ${index + 1}`;
    }
    if (!isRecord(entry) || entry.attempt !== journal.attempt)
      return `log line ${index + 1} is not this attempt's`;
    if (entry.op === "recorded") {
      log.recorded = true;
      continue;
    }
    const size =
      entry.target === "write"
        ? journal.writes.length
        : entry.target === "removal"
          ? journal.removals.length
          : -1;
    if (
      (entry.op !== "done" && entry.op !== "undone") ||
      typeof entry.index !== "number" ||
      !Number.isInteger(entry.index) ||
      entry.index < 0 ||
      entry.index >= size
    )
      return `bad log line ${index + 1}`;
    const key = logKey(entry.target as LogTarget, entry.index);
    (entry.op === "done" ? log.done : log.undone).add(key);
  }
  return log;
};

const readText = (
  file: string,
  io: MigrationIo
): { text: string } | { absent: true } | { error: string } => {
  try {
    return { text: io.readFileSync(file).toString("utf8") };
  } catch (error) {
    if (isAbsentError(error)) return { absent: true };
    return { error: error instanceof Error ? error.message : String(error) };
  }
};

/**
 * Reads and fully validates a staging's journal and log. Only a journal
 * that is genuinely absent is `missing`; a read error is `unreadable`, and
 * anything that does not validate is `invalid`. Never mutates.
 */
export const readJournal = (
  roots: JournalRoots,
  io: MigrationIo = nodeIo
): JournalRead => {
  const raw = readText(journalFile(roots.staging), io);
  if ("absent" in raw) return { status: "missing" };
  if ("error" in raw) return { status: "unreadable", error: raw.error };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.text);
  } catch {
    return { status: "invalid", error: "not JSON" };
  }
  const problem = validateJournal(parsed, roots);
  if (problem != null) return { status: "invalid", error: problem };
  const journal = parsed as CommitJournal;
  const logText = readText(logFile(roots.staging), io);
  if ("error" in logText)
    return { status: "unreadable", error: `log: ${logText.error}` };
  const log = parseLog("text" in logText ? logText.text : "", journal);
  if (typeof log === "string") return { status: "invalid", error: log };
  return { status: "ok", journal, log };
};

/** Every path a journal's commit may have changed. */
export const destinationsOf = (journal: CommitJournal): string[] => [
  ...journal.writes.map((write) => write.dest),
  ...journal.removals.map((removal) => removal.path),
];

export interface RollbackResult {
  restored: string[];
  deleted: string[];
  kept: string[];
}

export interface RollbackOptions {
  staging: string;
  journal: CommitJournal;
  log: JournalLog;
  io?: MigrationIo;
  /** Yields to the event loop every so many operations. */
  yieldEvery?: number;
  /** Told about a destination kept because it changed after the commit. */
  note?: (message: string) => void;
}

const tick = (): Promise<void> =>
  new Promise((resolve) => setImmediate(resolve));

/**
 * Drops a torn last line (a crash mid-append) before anything is appended
 * after it, so it never becomes a malformed line in the middle of the log.
 */
const trimTornTail = (staging: string, io: MigrationIo): void => {
  const file = logFile(staging);
  let text: string;
  try {
    text = io.readFileSync(file).toString("utf8");
  } catch (error) {
    if (isAbsentError(error)) return;
    throw error;
  }
  if (text === "" || text.endsWith("\n")) return;
  writeFileAtomic(file, text.slice(0, text.lastIndexOf("\n") + 1), io);
};

/**
 * Puts a commit back, whether or not each move happened, so it needs no
 * record of which did (the cross-volume copy has a window the log cannot
 * see: the destination published, the staged source not yet removed):
 *
 * - `create`: the destination did not exist when the commit began, and
 *   nothing else writes it before recovery, so it is deleted.
 * - `replace-derived`: left; it is correct derived data or will be
 *   regenerated.
 * - `replace-user`: by content. Equal to the original: nothing to do. Equal
 *   to what the commit staged: restored from the backup. Anything else was
 *   written after the commit (it should not be: writers are blocked while a
 *   commit is unresolved); it is kept, never overwritten, and logged.
 * - A removal: moved back from the backup when the original is gone. Both
 *   gone is data loss unless the log says this rollback already restored it
 *   (then something else deleted the file since): it throws, keeping the
 *   journal.
 *
 * Each operation appends `undone`, and a leftover `*.migrating-tmp` from a
 * crash is swept. Repeating a rollback after a crash part way is safe.
 * Throws on the first failure; the journal stays for the next launch.
 */
export const rollback = async (
  options: RollbackOptions
): Promise<RollbackResult> => {
  const io = options.io ?? nodeIo;
  const { journal, log, staging } = options;
  const every = options.yieldEvery ?? 20;
  const result: RollbackResult = { restored: [], deleted: [], kept: [] };
  let operations = 0;
  const undone = (target: LogTarget, index: number) => {
    appendLog(staging, journal.attempt, { op: "undone", target, index }, io);
  };
  const pace = async () => {
    operations += 1;
    if (operations % every === 0) await tick();
  };

  trimTornTail(staging, io);
  for (const [index, write] of journal.writes.entries()) {
    await pace();
    if (log.undone.has(logKey("write", index))) continue;
    io.rmSync(temporaryFor(write.dest));
    if (write.kind === "replace-derived") {
      result.kept.push(write.dest);
    } else if (write.kind === "create") {
      if (exists(write.dest, io)) {
        io.rmSync(write.dest);
        result.deleted.push(write.dest);
      }
    } else {
      const current = exists(write.dest, io)
        ? sha256File(write.dest, io)
        : null;
      if (current === write.originalHash) {
        // Never replaced, or already restored.
      } else if (current === write.stagedHash || current === null) {
        if (write.backup == null || !exists(write.backup, io))
          throw new Error(
            `backup ${String(write.backup)} of ${write.dest} is missing; not undoing`
          );
        // Only the original goes back: a damaged backup would replace the
        // file with garbage, and the journal and backup would then go.
        if (sha256File(write.backup, io) !== write.originalHash)
          throw new Error(
            `backup ${write.backup} of ${write.dest} does not match the original; not undoing`
          );
        copyFileAtomic(write.backup, write.dest, io);
        if (sha256File(write.dest, io) !== write.originalHash)
          throw new Error(`${write.dest} did not restore to the original`);
        result.restored.push(write.dest);
      } else {
        options.note?.(
          `${write.dest} changed after the commit; kept, not restored`
        );
        result.kept.push(write.dest);
      }
    }
    undone("write", index);
  }

  for (const [index, removal] of journal.removals.entries()) {
    await pace();
    if (log.undone.has(logKey("removal", index))) continue;
    io.rmSync(temporaryFor(removal.path));
    io.rmSync(temporaryFor(removal.backup));
    if (!exists(removal.path, io)) {
      if (!exists(removal.backup, io))
        throw new Error(
          `${removal.path} and its backup ${removal.backup} are both missing; not undoing`
        );
      moveFile(removal.backup, removal.path, io);
      result.restored.push(removal.path);
    }
    undone("removal", index);
  }
  return result;
};
