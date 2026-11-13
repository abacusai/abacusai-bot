/**
 * One lock for the whole memory folder, across processes: several agent
 * children and the desktop all write it, and an unlocked read-modify-write
 * loses changes silently.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

/**
 * How long a writer waits, and the backstop past which a lock is broken even
 * though its holder may still be running.
 *
 * Staleness is not measured in age: a holder can be descheduled for seconds
 * and its synchronous critical section cannot refresh a timestamp, so an age
 * rule would hand the store to a second writer mid read-modify-write. The
 * question asked is whether the holder is still there. The backstop covers a
 * recycled pid and a lock stamped by another machine sharing the home
 * directory. It is wall-clock (mtime is the only shared clock), so the bound
 * must be generous enough that ordinary skew and sleeps do not reach it.
 */
const LOCK_WAIT_MS = 5_000;
const LOCK_POLL_MS = 20;
const ABANDONED_LOCK_MS = 600_000;

/**
 * Waiting yields rather than blocks: the desktop calls this on the process
 * that draws every window, and a blocking sleep there freezes the whole app.
 */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Who holds a lock: machine, process, and acquisition. The host is recorded
 * because home directories get shared between machines, where a bare pid
 * would name an unrelated local process. Two containers reporting the same
 * generic hostname are indistinguishable here and fall back to bare pids.
 */
const lockOwner = (): string =>
  JSON.stringify({
    host: os.hostname(),
    pid: process.pid,
    nonce: randomUUID(),
  });

/**
 * The host and pid a lock names, or null when it does not name them yet.
 * JSON rather than delimited fields: macOS can hand back a hostname like
 * `Unknown_9e:a1:a0:d0:f9:c0`, which any delimiter split would misread. A
 * partial write is not valid JSON, so it reads as nameless and is honoured,
 * the safe direction for a lock one syscall from being stamped.
 */
const holderOf = (contents: string): { host: string; pid: number } | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents);
  } catch {
    return null;
  }

  if (parsed == null || typeof parsed !== "object") return null;

  const { host, pid, nonce } = parsed as Record<string, unknown>;

  if (typeof host !== "string" || host.length === 0) return null;
  if (typeof nonce !== "string" || nonce.length === 0) return null;
  if (!Number.isInteger(pid) || (pid as number) <= 0) return null;

  return { host, pid: pid as number };
};

/**
 * Signal 0 asks after a process without touching it, on Windows too; EPERM
 * means it exists and belongs to someone else. A holder on another machine
 * cannot be asked, so it is left to the backstop.
 */
const holderMayBeRunning = (holder: { host: string; pid: number }): boolean => {
  if (holder.host !== os.hostname()) return true;

  try {
    process.kill(holder.pid, 0);

    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/**
 * Remove a lock nobody is coming back for: the holder is gone, or the lock
 * has outlived the backstop. A lock with no identity yet is honoured, since
 * creating and stamping the file are two syscalls and a waiter in that gap
 * would delete a live writer's lock. The contents are re-read before removal
 * because the lock can change hands in between.
 */
const breakAbandonedLock = (lock: string): void => {
  try {
    const before = fs.readFileSync(lock, "utf8");
    const holder = holderOf(before);
    const age = Date.now() - fs.statSync(lock).mtimeMs;

    if (age < ABANDONED_LOCK_MS) {
      if (holder == null || holderMayBeRunning(holder)) return;
    }

    if (fs.readFileSync(lock, "utf8") === before)
      fs.rmSync(lock, { force: true });
  } catch {
    // It went away between the calls; the next attempt takes it.
  }
};

/**
 * Run `body` holding `lock`, a file created with "wx" (the one operation every
 * filesystem agrees is atomic) carrying the holder's identity. Null when the
 * lock could not be taken within LOCK_WAIT_MS: nothing ran, and the caller
 * says so rather than losing a write silently.
 */
export const withFileLock = async <T>(
  lock: string,
  body: () => T
): Promise<{ value: T } | null> => {
  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const owner = lockOwner();
  const deadline = Date.now() + LOCK_WAIT_MS;

  for (;;) {
    try {
      const handle = fs.openSync(lock, "wx");

      try {
        fs.writeSync(handle, owner);
      } catch (error) {
        // A nameless lock is honoured, so leaving this one (usually a full
        // disk) would hold the folder shut until the backstop, minutes away.
        fs.rmSync(lock, { force: true });
        throw error;
      } finally {
        fs.closeSync(handle);
      }
      break;
    } catch (error) {
      // Windows answers EPERM for a lock file being deleted under it.
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "EEXIST" && code !== "EPERM" && code !== "EBUSY")
        throw error;
      breakAbandonedLock(lock);
      if (Date.now() >= deadline) return null;
      await sleep(LOCK_POLL_MS);
    }
  }

  try {
    return { value: body() };
  } finally {
    try {
      // Compared before removing, so a lock broken and retaken is left to its
      // new holder.
      if (fs.readFileSync(lock, "utf8") === owner)
        fs.rmSync(lock, { force: true });
    } catch {
      // Already gone; whoever removed it judged this process to be finished.
    }
  }
};
