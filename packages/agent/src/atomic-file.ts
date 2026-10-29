/**
 * Stage-and-rename file writes, shared by every store in the repo.
 *
 * Durable as well as atomic: the staged bytes are flushed to the disk before
 * the rename. Without that the filesystem may commit the rename (and the new
 * size) ahead of the data, so a power loss or a sleep that never wakes leaves
 * a file of the right length that is all NUL bytes, on NTFS and ext4 alike.
 *
 * Two Windows constraints shape this: a rename onto a file anyone holds open
 * is refused with EPERM (POSIX allows it), and a temp name derived only from
 * the target collides between the desktop and its agent processes, which
 * share these directories.
 */
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

export interface AtomicWriteOptions {
  /** 0600, applied to the temp file too so it is never briefly world-readable. */
  restrict?: boolean;
  /**
   * Skip the write when the file already holds these bytes, sparing readers a
   * rename. Costs a read, so pointless for content that always differs.
   */
  skipIfUnchanged?: boolean;
  /**
   * Also keep the same bytes at `backupPathFor(filePath)`, written (and
   * flushed) first, so at every moment one of the two is whole. For stores
   * whose loss costs the user something; read them back with
   * `recoverFromBackupSync`.
   */
  keepBackup?: boolean;
}

/** Where `keepBackup` keeps the last good copy of `filePath`. */
export const backupPathFor = (filePath: string): string => `${filePath}.bak`;

/** Errors a moment's wait can clear. Anything else is not about timing. */
const RETRYABLE_RENAME_CODES = new Set(["EPERM", "EACCES", "EBUSY"]);
const RENAME_ATTEMPTS = 3;
const RENAME_BACKOFF_MS = 5;

let writeCounter = 0;

/** Unique per write, so overlapping writers never share a temp file. */
const tempPathFor = (filePath: string): string =>
  `${filePath}.${process.pid}.${++writeCounter}.tmp`;

const isRetryable = (err: unknown): boolean =>
  RETRYABLE_RENAME_CODES.has((err as { code?: string }).code ?? "");

/** Best effort: Windows and some network filesystems have no POSIX modes. */
const restrictToOwner = (filePath: string): void => {
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Nothing to fall back to.
  }
};

const unchanged = (filePath: string, contents: string): boolean => {
  try {
    return fs.readFileSync(filePath, "utf-8") === contents;
  } catch {
    // Absent or unreadable: either way, write it.
    return false;
  }
};

/**
 * Writes `contents` to `filePath` and flushes it to the disk before
 * returning. Not atomic on its own: for callers that stage and rename
 * themselves.
 */
export function writeFileDurableSync(
  filePath: string,
  contents: string | Uint8Array,
  options: { mode?: number } = {}
): void {
  const fd = fs.openSync(filePath, "w", options.mode ?? 0o666);
  try {
    fs.writeFileSync(fd, contents);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/**
 * Flushes the rename itself on POSIX, where it lives in the directory's
 * entry. Windows cannot open a directory for this; NTFS journals the rename.
 */
const syncDirectory = (dir: string): void => {
  if (process.platform === "win32") return;
  let fd: number;
  try {
    fd = fs.openSync(dir, "r");
  } catch {
    // Unopenable (a network mount): the data is flushed; the rename is not.
    return;
  }
  try {
    fs.fsyncSync(fd);
  } catch {
    // Some filesystems refuse to sync a directory (EINVAL); nothing more to do.
  } finally {
    fs.closeSync(fd);
  }
};

const syncDirectoryAsync = async (dir: string): Promise<void> => {
  if (process.platform === "win32") return;
  const handle = await fsPromises.open(dir, "r").catch(() => null);
  if (handle == null) return;
  try {
    await handle.sync().catch(() => {});
  } finally {
    await handle.close();
  }
};

const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

/** Blocks the thread, so keep the budget tiny. */
const sleepSync = (ms: number): void => {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
};

export function writeFileAtomicSync(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): void {
  if (options.skipIfUnchanged === true && unchanged(filePath, contents)) {
    // Still chmod: the bytes may match a file written by something else.
    if (options.restrict === true) restrictToOwner(filePath);
    return;
  }

  if (options.keepBackup === true)
    writeFileAtomicSync(backupPathFor(filePath), contents, {
      restrict: options.restrict,
    });

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  try {
    writeFileDurableSync(
      temp,
      contents,
      options.restrict === true ? { mode: 0o600 } : {}
    );
    if (options.restrict === true) restrictToOwner(temp);

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
      try {
        fs.renameSync(temp, filePath);
        break;
      } catch (err) {
        if (attempt === RENAME_ATTEMPTS || !isRetryable(err)) throw err;
        sleepSync(RENAME_BACKOFF_MS * attempt);
      }
    }
    syncDirectory(path.dirname(filePath));
    // A rename onto an existing file keeps that file's mode, not the temp's.
    if (options.restrict === true) restrictToOwner(filePath);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing to fall back to.
    }
    throw err;
  }
}

/** Async counterpart. */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  if (options.keepBackup === true)
    await writeFileAtomic(backupPathFor(filePath), contents, {
      restrict: options.restrict,
    });

  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  try {
    const handle = await fsPromises.open(
      temp,
      "w",
      options.restrict === true ? 0o600 : 0o666
    );
    try {
      await handle.writeFile(contents, "utf-8");
      await handle.sync();
    } finally {
      await handle.close();
    }

    for (let attempt = 1; attempt <= RENAME_ATTEMPTS; attempt++) {
      try {
        await fsPromises.rename(temp, filePath);
        break;
      } catch (err) {
        if (attempt === RENAME_ATTEMPTS || !isRetryable(err)) throw err;
        await new Promise((resolve) =>
          setTimeout(resolve, RENAME_BACKOFF_MS * attempt)
        );
      }
    }
    await syncDirectoryAsync(path.dirname(filePath));
    if (options.restrict === true) restrictToOwner(filePath);
  } catch (err) {
    await fsPromises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}

/**
 * Puts back the backup `keepBackup` kept when `filePath` holds bytes
 * `isValid` rejects (torn or NUL-filled by a crash). The rejected bytes are
 * kept beside it as `<file>.corrupt-<ms>` first, so nothing is ever thrown
 * away; if that copy fails, or there is no valid backup, the file is left
 * exactly as it is. Returns the restored text, or null when nothing was
 * restored. Only for a file whose bytes were read: an I/O error is not proof
 * the file is bad. `restrict` as the store writes it.
 */
export function recoverFromBackupSync(
  filePath: string,
  isValid: (text: string) => boolean,
  options: Pick<AtomicWriteOptions, "restrict"> = {}
): string | null {
  let backup: string;
  try {
    backup = fs.readFileSync(backupPathFor(filePath), "utf-8");
  } catch {
    return null;
  }
  if (!isValid(backup)) return null;
  try {
    fs.copyFileSync(
      filePath,
      `${filePath}.corrupt-${Date.now()}`,
      fs.constants.COPYFILE_EXCL
    );
  } catch {
    // The rejected bytes could not be kept: they stay where they are.
    return null;
  }
  writeFileAtomicSync(filePath, backup, options);
  return backup;
}
