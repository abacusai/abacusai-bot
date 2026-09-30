/**
 * The files writers must leave alone this launch because a migration commit
 * could not be settled (`RunMigrationsResult.unresolved`, spec 00 C.1). The
 * next launch's rollback would otherwise overwrite such a write, or be
 * defeated by it. Electron-free, so any main-process store (the thread
 * store, `TranscriptService`, `PrefsStore`'s wiring) can ask.
 *
 * `startup.ts` sets it once, after the runner resolves and before any
 * service starts. Until then, and when every attempt settled, nothing is
 * blocked.
 */
import { isWriteBlocked, type RunMigrationsResult } from "./runner";

let current: Pick<RunMigrationsResult, "unresolved"> | null = null;

export const setMigrationWriteBlocks = (
  result: Pick<RunMigrationsResult, "unresolved"> | null
): void => {
  current = result;
};

/**
 * True when `file` (absolute) may be covered by an unresolved commit: listed
 * among its destinations, or any file at all when the attempt's journal
 * could not be read. A writer that gets true must not write `file` this
 * launch (keep the change in memory, or skip it).
 */
export const isMigrationWriteBlocked = (file: string): boolean =>
  isWriteBlocked(current, file);
