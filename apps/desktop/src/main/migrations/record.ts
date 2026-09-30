/**
 * `~/.abacusai-bot/migrations.json` (spec 00 C.1): which steps have been
 * applied, and the last failure. Written atomically. A missing or corrupt
 * file means nothing has been applied; every step is idempotent, so running
 * one again is safe.
 */
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

export interface AppliedMigration {
  id: number;
  name: string;
  appliedAt: string;
  appVersion: string;
  durationMs: number;
  stats: Record<string, number>;
  /**
   * The commit's stamp, also in its journal. A journal found on the next
   * launch whose commit is recorded here belongs to a commit that finished
   * (it died while deleting its staging), so it is not undone.
   */
  commit: string;
}

export interface MigrationFailure {
  id: number;
  name: string;
  at: string;
  error: string;
}

export interface MigrationRecord {
  version: 1;
  applied: AppliedMigration[];
  lastFailure?: MigrationFailure;
}

export const RECORD_FILE_NAME = "migrations.json";

export const recordFile = (home: string): string =>
  path.join(home, RECORD_FILE_NAME);

const isApplied = (value: unknown): value is AppliedMigration => {
  if (typeof value !== "object" || value === null) return false;
  const entry = value as Partial<AppliedMigration>;
  return (
    typeof entry.id === "number" &&
    Number.isInteger(entry.id) &&
    typeof entry.name === "string"
  );
};

export const emptyRecord = (): MigrationRecord => ({
  version: 1,
  applied: [],
});

export const readRecord = (home: string): MigrationRecord => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(recordFile(home), "utf8"));
  } catch {
    return emptyRecord();
  }
  if (typeof parsed !== "object" || parsed === null) return emptyRecord();
  const raw = parsed as { applied?: unknown; lastFailure?: unknown };
  const record = emptyRecord();
  if (Array.isArray(raw.applied))
    record.applied = raw.applied.filter(isApplied);
  const failure = raw.lastFailure as Partial<MigrationFailure> | undefined;
  if (
    failure != null &&
    typeof failure.id === "number" &&
    typeof failure.name === "string"
  )
    record.lastFailure = failure as MigrationFailure;
  return record;
};

export const writeRecord = (home: string, record: MigrationRecord): void => {
  fs.mkdirSync(home, { recursive: true });
  writeFileAtomicSync(recordFile(home), `${JSON.stringify(record, null, 2)}\n`);
};
