/**
 * Stage-and-rename file writes, shared by every store in the repo.
 *
 * Two Windows constraints shape this: a rename onto a file anyone holds open
 * is refused with EPERM (POSIX allows it), and a temp name derived only from
 * the target collides between the desktop and the CLI, which share these
 * directories.
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
    await fsPromises.rm(temp, { force: true }).catch(() => {});
    throw err;
  }
}
