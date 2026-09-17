/**
 * Writing a file without ever leaving a half-written one behind.
 *
 * Every store in this repo that matters — MCP config, bots, transcripts, auth
 * tokens — stages its content in a temp file and renames it into place, since
 * a rename is the one filesystem operation a reader cannot catch midway. They
 * each grew their own copy of that, with their own bugs; this is the one copy.
 *
 * Two things the naive version gets wrong, both learned on Windows:
 *
 *  - A temp name derived only from the target is shared by every writer of it.
 *    The desktop and the CLI share these directories, so two writers interleave
 *    into one temp file and one renames what the other still holds open.
 *  - A rename onto a file anyone has open is refused outright (EPERM), where
 *    POSIX would allow it. A session reloading its config is enough to cause
 *    it, and the write it bounces had nothing wrong with it.
 */
import fs from "fs";
import fsPromises from "fs/promises";
import path from "path";

export interface AtomicWriteOptions {
  /**
   * Restrict the file to its owner (0600). For anything carrying secrets:
   * bearer tokens, OAuth material, whatever a connector's `env` holds. Set on
   * the temp file too, so it is never briefly readable with a looser mode.
   */
  restrict?: boolean;
  /**
   * Return without writing when the file already holds exactly these bytes.
   * For files rewritten far more often than they change — the caller saves a
   * rename, and a reader of the file is never disturbed by a write that had
   * nothing to say. Not worth it for content that always differs (anything
   * stamped with a time), where the read is pure overhead.
   */
  skipIfUnchanged?: boolean;
}

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
    // Nothing to fall back to, and failing the write would be worse than a
    // file with the mode the platform chose.
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
 * The wait between rename attempts blocks, because a synchronous write has no
 * way to yield. That is why the budget is two short waits and not more: past
 * it the caller hears about the failure rather than the app stalling for it.
 */
const sleepSync = (ms: number): void => {
  Atomics.wait(SLEEP_SIGNAL, 0, 0, ms);
};
const SLEEP_SIGNAL = new Int32Array(new SharedArrayBuffer(4));

export function writeFileAtomicSync(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): void {
  if (options.skipIfUnchanged === true && unchanged(filePath, contents)) {
    if (options.restrict === true) restrictToOwner(filePath);
    return;
  }

  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  try {
    fs.writeFileSync(temp, contents, "utf-8");
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
    // After the rename: a file that already existed keeps its own mode through
    // one, so the temp file's mode is not what ends up on disk.
    if (options.restrict === true) restrictToOwner(filePath);
  } catch (err) {
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // A temp file someone else has locked is the smaller problem; the write
      // already failed, and that is what the caller needs to hear about.
    }
    throw err;
  }
}

/** The same guarantees where the caller can await, and the wait yields. */
export async function writeFileAtomic(
  filePath: string,
  contents: string,
  options: AtomicWriteOptions = {}
): Promise<void> {
  await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
  const temp = tempPathFor(filePath);
  try {
    await fsPromises.writeFile(temp, contents, {
      encoding: "utf-8",
      ...(options.restrict === true ? { mode: 0o600 } : {}),
    });

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
    if (options.restrict === true) restrictToOwner(filePath);
  } catch (err) {
    await fsPromises.rm(temp, { force: true }).catch(() => {
      // See the sync path: the write's own failure is the one that matters.
    });
    throw err;
  }
}
