/**
 * The commit journal (spec 00 C.1): written into a step's staging directory
 * before its first rename, updated after each, and deleted with the staging
 * once the record holds the step. Finding one on launch means a commit died
 * part way; `undoCommit` puts every destination back.
 */
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";

import { copyFileAtomic, exists, moveFile } from "./backup";
import type { WriteKind } from "./types";

export const JOURNAL_NAME = "commit.journal";

export interface JournalWrite {
  dest: string;
  staged: string;
  kind: WriteKind;
  /** The copy of `dest` taken before the rename; null when there was none. */
  backup: string | null;
}

export interface JournalRemoval {
  path: string;
  /** Where the file is moved; also where recovery finds it. */
  backup: string;
}

export interface CommitJournal {
  version: 1;
  id: number;
  name: string;
  /** Stamp shared with the record entry (`AppliedMigration.commit`). */
  commit: string;
  backupDir: string;
  writes: JournalWrite[];
  removals: JournalRemoval[];
  /** Destinations renamed and removals moved, in order. */
  done: string[];
}

export const journalFile = (staging: string): string =>
  path.join(staging, JOURNAL_NAME);

export const writeJournal = (staging: string, journal: CommitJournal): void => {
  writeFileAtomicSync(journalFile(staging), JSON.stringify(journal));
};

const isJournal = (value: unknown): value is CommitJournal => {
  if (typeof value !== "object" || value === null) return false;
  const journal = value as Partial<CommitJournal>;
  return (
    typeof journal.id === "number" &&
    typeof journal.name === "string" &&
    typeof journal.commit === "string" &&
    typeof journal.backupDir === "string" &&
    Array.isArray(journal.writes) &&
    Array.isArray(journal.removals) &&
    Array.isArray(journal.done)
  );
};

export const readJournal = (
  staging: string
): CommitJournal | "missing" | "corrupt" => {
  let raw: string;
  try {
    raw = fs.readFileSync(journalFile(staging), "utf8");
  } catch {
    return "missing";
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isJournal(parsed) ? parsed : "corrupt";
  } catch {
    return "corrupt";
  }
};

export interface UndoResult {
  restored: string[];
  deleted: string[];
  kept: string[];
}

/**
 * Puts a part-done commit back:
 * - a `replace-user` destination is restored from its backup (deleted when it
 *   had none: it did not exist before);
 * - a `create` destination is deleted;
 * - a `replace-derived` destination is left: it is correct derived data or
 *   will be regenerated;
 * - a removed file is moved back from the backup directory.
 *
 * A rename counts as done when the journal says so or its staged file is
 * gone: a crash between a rename and the journal update must still be
 * undone. Throws on the first failure, leaving the journal for next time.
 */
export const undoCommit = (journal: CommitJournal): UndoResult => {
  const result: UndoResult = { restored: [], deleted: [], kept: [] };
  const done = new Set(journal.done);
  for (const write of journal.writes) {
    const renamed = done.has(write.dest) || !exists(write.staged);
    if (!renamed) continue;
    if (write.kind === "replace-derived") {
      result.kept.push(write.dest);
      continue;
    }
    if (write.kind === "replace-user" && write.backup != null) {
      if (exists(write.backup)) {
        copyFileAtomic(write.backup, write.dest);
        result.restored.push(write.dest);
        continue;
      }
      throw new Error(
        `backup ${write.backup} of ${write.dest} is missing; not undoing`
      );
    }
    fs.rmSync(write.dest, { force: true });
    result.deleted.push(write.dest);
  }
  for (const removal of journal.removals) {
    if (exists(removal.path) || !exists(removal.backup)) continue;
    moveFile(removal.backup, removal.path);
    result.restored.push(removal.path);
  }
  return result;
};
