/**
 * The files writers must leave alone this launch because a migration commit
 * could not be settled (`RunMigrationsResult.unresolved`, spec 00 C.1). The
 * next launch's rollback would otherwise overwrite such a write, or be
 * defeated by it. Electron-free, so any main-process store (the thread
 * store, `TranscriptService`, the workspace file operations) can ask.
 *
 * `startup.ts` sets it once, after the runner resolves and before any
 * service starts. Until then, and when every attempt settled, nothing is
 * blocked.
 *
 * Paths are compared canonically: symlinks in the existing part of a path
 * are resolved, and case is folded where the filesystem usually ignores it
 * (macOS, Windows), so another spelling of a held file is held too.
 */
import fs from "node:fs";
import path from "node:path";

import type { RunMigrationsResult } from "./runner";

interface Blocks {
  /** Some attempt's destinations are unknown: everything is held. */
  all: boolean;
  destinations: string[];
}

let blocks: Blocks = { all: false, destinations: [] };

const fold = (file: string): string =>
  process.platform === "darwin" || process.platform === "win32"
    ? file.toLowerCase()
    : file;

/** The real path of the nearest existing ancestor, plus the rest. */
export const canonicalPath = (file: string): string => {
  const missing: string[] = [];
  let head = path.resolve(file);
  for (;;) {
    try {
      return fold(path.join(fs.realpathSync.native(head), ...missing));
    } catch {
      const parent = path.dirname(head);
      if (parent === head) return fold(path.resolve(file));
      missing.unshift(path.basename(head));
      head = parent;
    }
  }
};

export const setMigrationWriteBlocks = (
  result: Pick<RunMigrationsResult, "unresolved"> | null
): void => {
  const unresolved = result?.unresolved ?? [];
  blocks = {
    all: unresolved.some((attempt) => attempt.destinations == null),
    destinations: unresolved.flatMap((attempt) =>
      (attempt.destinations ?? []).map(canonicalPath)
    ),
  };
};

/**
 * True when `file` (absolute) may be covered by an unresolved commit: one of
 * its destinations, or any file at all when an attempt's journal could not
 * be read. A writer that gets true must not write `file` this launch (keep
 * the change in memory, or refuse it).
 */
export const isMigrationWriteBlocked = (file: string): boolean => {
  if (blocks.all) return true;
  if (blocks.destinations.length === 0) return false;
  const target = canonicalPath(file);
  return blocks.destinations.includes(target);
};

/**
 * For an operation on a whole path (a rename, a trash, a recursive delete):
 * true when `target` is a held file, or a directory holding one.
 */
export const isMigrationWriteBlockedTree = (target: string): boolean => {
  if (blocks.all) return true;
  if (blocks.destinations.length === 0) return false;
  const root = canonicalPath(target);
  return blocks.destinations.some(
    (destination) =>
      destination === root || destination.startsWith(`${root}${path.sep}`)
  );
};
