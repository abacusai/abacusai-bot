/**
 * `~/.abacusai-bot/migrations.json` (spec 00 C.1): which steps have been
 * applied, and the last failure. Written atomically.
 *
 * Reading tells apart what the runner must treat differently:
 * - `missing`: nothing applied yet;
 * - `ok`: a version-1 record;
 * - `corrupt`: bytes that are not a valid record. Nothing in it can be
 *   trusted, so an interrupted commit cannot be judged by it; with no such
 *   commit pending, it is set aside (kept, renamed) and the steps run again,
 *   which is safe since every step is idempotent;
 * - `unreadable`: a read error other than absence (EACCES, EIO). Nothing is
 *   judged and nothing is written;
 * - `newer`: written by a later build (a downgrade). This build runs no step
 *   and never writes the record, so the newer fields survive.
 */
import path from "node:path";

import {
  formatStamp,
  isAbsentError,
  nodeIo,
  writeFileAtomic,
  type MigrationIo,
} from "./backup";

export interface AppliedMigration {
  id: number;
  name: string;
  appliedAt: string;
  appVersion: string;
  durationMs: number;
  stats: Record<string, number>;
  /** The commit's stamp. */
  commit: string;
  /**
   * The commit attempt, also in its journal: a journal found on the next
   * launch whose step and attempt are recorded here belongs to a commit that
   * finished (it died while deleting its staging), so it is not undone.
   * Absent only in entries written before attempts existed.
   */
  attempt?: string;
  /** The backup directory's name under `backups/migrations/`, if any. */
  backup?: string;
}

export interface MigrationFailure {
  id: number;
  name: string;
  at: string;
  error: string;
}

export const RECORD_VERSION = 1;

export interface MigrationRecord {
  version: typeof RECORD_VERSION;
  applied: AppliedMigration[];
  lastFailure?: MigrationFailure;
}

export type RecordRead =
  | { status: "missing"; record: MigrationRecord }
  | { status: "ok"; record: MigrationRecord }
  | { status: "corrupt"; error: string }
  | { status: "unreadable"; error: string }
  | { status: "newer"; version: number };

export const RECORD_FILE_NAME = "migrations.json";

export const recordFile = (home: string): string =>
  path.join(home, RECORD_FILE_NAME);

const isRecordObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isApplied = (value: unknown): value is AppliedMigration => {
  if (!isRecordObject(value)) return false;
  return (
    typeof value.id === "number" &&
    Number.isInteger(value.id) &&
    typeof value.name === "string" &&
    typeof value.commit === "string" &&
    (value.attempt === undefined || typeof value.attempt === "string") &&
    (value.backup === undefined || typeof value.backup === "string")
  );
};

const isFailure = (value: unknown): value is MigrationFailure =>
  isRecordObject(value) &&
  typeof value.id === "number" &&
  typeof value.name === "string" &&
  typeof value.at === "string" &&
  typeof value.error === "string";

export const emptyRecord = (): MigrationRecord => ({
  version: RECORD_VERSION,
  applied: [],
});

export const readRecordState = (
  home: string,
  io: MigrationIo = nodeIo
): RecordRead => {
  let text: string;
  try {
    text = io.readFileSync(recordFile(home)).toString("utf8");
  } catch (error) {
    if (isAbsentError(error))
      return { status: "missing", record: emptyRecord() };
    return {
      status: "unreadable",
      error: error instanceof Error ? error.message : String(error),
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { status: "corrupt", error: "not JSON" };
  }
  if (!isRecordObject(parsed))
    return { status: "corrupt", error: "not an object" };
  const { version } = parsed;
  if (typeof version === "number" && Number.isInteger(version))
    if (version > RECORD_VERSION) return { status: "newer", version };
  if (version !== RECORD_VERSION)
    return {
      status: "corrupt",
      error: `bad version ${JSON.stringify(version)}`,
    };
  if (!Array.isArray(parsed.applied) || !parsed.applied.every(isApplied))
    return { status: "corrupt", error: "bad applied entries" };
  if (parsed.lastFailure !== undefined && !isFailure(parsed.lastFailure))
    return { status: "corrupt", error: "bad lastFailure" };
  const record: MigrationRecord = {
    version: RECORD_VERSION,
    applied: parsed.applied,
  };
  if (isFailure(parsed.lastFailure)) record.lastFailure = parsed.lastFailure;
  return { status: "ok", record };
};

/** The record, or an empty one when it is not `ok` (tests, logging). */
export const readRecord = (
  home: string,
  io: MigrationIo = nodeIo
): MigrationRecord => {
  const state = readRecordState(home, io);
  return state.status === "ok" || state.status === "missing"
    ? state.record
    : emptyRecord();
};

export const writeRecord = (
  home: string,
  record: MigrationRecord,
  io: MigrationIo = nodeIo
): void => {
  writeFileAtomic(recordFile(home), `${JSON.stringify(record, null, 2)}\n`, io);
};

/**
 * Keeps a corrupt record beside the new one
 * (`migrations.json.corrupt-<stamp>`) instead of overwriting it.
 */
export const setAsideCorruptRecord = (
  home: string,
  now: Date,
  io: MigrationIo = nodeIo
): string => {
  const aside = `${recordFile(home)}.corrupt-${formatStamp(now)}`;
  io.renameSync(recordFile(home), aside);
  return aside;
};

/** The backup directory name an applied entry points at. */
export const backupOf = (entry: AppliedMigration): string =>
  entry.backup ?? `${entry.commit}-${entry.id}-${entry.name}`;
