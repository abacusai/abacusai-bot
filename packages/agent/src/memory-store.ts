/**
 * Reading and writing what the agent remembers, from the agent itself. Under
 * the desktop a frozen snapshot arrives as ABACUSAI_BOT_MEMORY_SNAPSHOT; an
 * agent started without one reads the same files the app writes.
 *
 * The format is duplicated because this package cannot reach the app's source
 * tree. Keep it in step with apps/desktop/src/main/services/agent-tools/memory-store.ts.
 */
import { randomUUID } from "crypto";
import fs from "fs";
import os from "os";
import path from "path";

import { abacusBotDir } from "./config.js";

/**
 * "remember" is the user's own list, re-read every turn so "remember I like
 * blue" lands on the very next answer; the other two are the agent's notes.
 */
export type MemoryTarget = "memory" | "user" | "remember";

export type MemoryAction = "add" | "replace" | "remove";

export interface MemoryResult {
  ok: boolean;
  message: string;
  /** Live entries after the operation, so the model sees what it just did. */
  entries?: string[];
}

const STORE_FILES: Record<MemoryTarget, string> = {
  memory: "MEMORY.md",
  user: "USER.md",
  remember: "REMEMBER.md",
};

/** Matched by the desktop when it rebuilds the prompt; keep the wording. */
const STORE_HEADERS: Record<MemoryTarget, string> = {
  memory: "MEMORY (your personal notes)",
  user: "USER PROFILE (who the user is)",
  remember: "ALWAYS REMEMBER (the user asked you to keep these)",
};

const ENTRY_DELIMITER = "\n§\n";

const storePath = (target: MemoryTarget): string =>
  path.join(abacusBotDir(), "memories", STORE_FILES[target]);

/** Memory is curated, not a log: past this it stops earning its prompt space. */
const MAX_ENTRY_CHARS = 2_000;
const MAX_STORE_CHARS = 20_000;

/** A line that is exactly `§` would split one entry into several on reread. */
const containsDelimiter = (content: string): boolean =>
  /(^|\n)\s*§\s*(\n|$)/.test(content);

const DELIMITER_MESSAGE =
  'That entry contains a line with only "§", which is reserved as the entry separator. Reword it.';

export const readEntries = (target: MemoryTarget): string[] => {
  try {
    return fs
      .readFileSync(storePath(target), "utf8")
      .split(ENTRY_DELIMITER)
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  } catch {
    // A missing store is the normal state on a fresh install, not an error.
    return [];
  }
};

/**
 * The same block the desktop passes at spawn, or null when nothing is stored.
 * Read once at session start: a prompt that changes mid-session invalidates
 * the provider's prefix cache for every remaining turn.
 */
export const memorySnapshot = (): string | null => {
  const blocks: string[] = [];

  for (const target of ["memory", "user"] as const) {
    const entries = readEntries(target);

    if (entries.length === 0) continue;

    blocks.push(
      `${STORE_HEADERS[target]}\n${entries.map((entry) => `- ${entry}`).join("\n")}`
    );
  }

  return blocks.length > 0 ? blocks.join("\n\n") : null;
};

/**
 * What the user asked to be remembered, re-read every turn on purpose:
 * "remember I like blue" means the next answer, and a hand-maintained store
 * is small enough that re-reading it is not what costs the prefix cache.
 */
export const rememberSnapshot = (): string | null => {
  const entries = readEntries("remember");

  if (entries.length === 0) return null;

  return `${STORE_HEADERS.remember}\n${entries
    .map((entry) => `- ${entry}`)
    .join("\n")}`;
};

/** Makes each write's temp file its own; see the comment in writeEntries. */
let writeCounter = 0;

const writeEntries = (target: MemoryTarget, entries: string[]): void => {
  const file = storePath(target);

  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Temp file plus rename so a crash mid-write cannot leave a half-flushed
  // store. The temp name is unique per process and write: the desktop and
  // CLI share these files, and a fixed name lets two writers interleave.
  const temp = `${file}.${process.pid}.${++writeCounter}.tmp`;

  try {
    fs.writeFileSync(temp, entries.join(ENTRY_DELIMITER), "utf8");
    fs.renameSync(temp, file);
  } finally {
    // On failure (usually a full disk) the unique name would otherwise leave
    // an orphan per attempt, without limit.
    try {
      fs.rmSync(temp, { force: true });
    } catch {
      // Nothing left to clean up.
    }
  }
};

// ── shared lock — keep byte-identical with the other copy ─────────────────

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

/** Told to the caller when the lock could not be taken. Nothing was written. */
const BUSY_MESSAGE =
  "Memory is being updated by another session right now, so nothing was changed. Try again.";

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
 * Run `body` with exclusive access to one store, across processes: several
 * agent children and the CLI all write these files, and an unlocked
 * read-modify-write loses entries silently. The lock is a file created with
 * "wx" (the one operation every filesystem agrees is atomic) carrying the
 * holder's identity. A writer that cannot take it within LOCK_WAIT_MS reports
 * that and changes nothing; losing a write loudly beats losing it silently.
 */
const withStoreLock = async (
  target: MemoryTarget,
  body: () => MemoryResult
): Promise<MemoryResult> => {
  const lock = `${storePath(target)}.lock`;

  fs.mkdirSync(path.dirname(lock), { recursive: true });

  const owner = lockOwner();
  const deadline = Date.now() + LOCK_WAIT_MS;
  let held = false;

  for (;;) {
    try {
      const handle = fs.openSync(lock, "wx");

      try {
        fs.writeSync(handle, owner);
      } catch (error) {
        // A nameless lock is honoured, so leaving this one (usually a full
        // disk) would hold the store shut until the backstop, minutes away.
        fs.rmSync(lock, { force: true });
        throw error;
      } finally {
        fs.closeSync(handle);
      }

      held = true;
      break;
    } catch {
      breakAbandonedLock(lock);

      if (Date.now() >= deadline) break;

      await sleep(LOCK_POLL_MS);
    }
  }

  if (!held)
    return { ok: false, message: BUSY_MESSAGE, entries: readEntries(target) };

  try {
    return body();
  } finally {
    try {
      // Compared before removing, so a lock broken and retaken is left to its
      // new holder. Nothing may break it between the two calls: this process
      // is plainly running.
      if (fs.readFileSync(lock, "utf8") === owner)
        fs.rmSync(lock, { force: true });
    } catch {
      // Already gone; whoever removed it judged this process to be finished.
    }
  }
};

// ── end shared lock ───────────────────────────────────────────────────────

/**
 * Entries matching `fragment`, which must identify exactly one. Ambiguity is
 * reported: picking the first match would quietly edit the wrong entry.
 */
const findByFragment = (
  entries: string[],
  fragment: string
): { index: number; error?: string } => {
  const needle = fragment.trim().toLowerCase();

  if (needle.length === 0)
    return { index: -1, error: "No text to match was given." };

  const matches = entries
    .map((entry, index) => ({ entry, index }))
    .filter(({ entry }) => entry.toLowerCase().includes(needle));

  if (matches.length === 0)
    return { index: -1, error: `Nothing in memory contains "${fragment}".` };

  if (matches.length > 1) {
    return {
      index: -1,
      error: `"${fragment}" matches ${matches.length} entries. Use a longer, more specific fragment.`,
    };
  }

  return { index: matches[0]!.index };
};

/** The desktop adds the nudge only on add; kept so both surfaces read alike. */
const tooLong = (content: string, hint: "add" | "replace"): string | null => {
  if (content.length <= MAX_ENTRY_CHARS) return null;

  const base = `That entry is ${content.length} characters; the limit is ${MAX_ENTRY_CHARS}.`;

  return hint === "add" ? `${base} Split it or write it more tightly.` : base;
};

const wouldOverflow = (next: string[], target: MemoryTarget): string | null => {
  const size = next.join(ENTRY_DELIMITER).length;

  return size > MAX_STORE_CHARS
    ? `This would take ${STORE_FILES[target]} to ${size} characters, over the ${MAX_STORE_CHARS} limit. Remove something stale first.`
    : null;
};

/**
 * Add, replace or remove one entry. Limits, messages and matching match the
 * desktop's store exactly, so the model meets one tool in both surfaces.
 */
export const applyMemoryAction = (
  target: MemoryTarget,
  action: MemoryAction,
  input: { content?: string; match?: string }
): Promise<MemoryResult> =>
  // The read and the write are one operation, or a concurrent session's entry
  // disappears between them.
  withStoreLock(target, () => applyMemoryActionLocked(target, action, input));

const applyMemoryActionLocked = (
  target: MemoryTarget,
  action: MemoryAction,
  input: { content?: string; match?: string }
): MemoryResult => {
  const entries = readEntries(target);

  if (action === "add") {
    const content = (input.content ?? "").trim();

    if (content.length === 0)
      return { ok: false, message: "Nothing to add — content was empty." };

    const long = tooLong(content, "add");

    if (long != null) return { ok: false, message: long };
    if (containsDelimiter(content))
      return { ok: false, message: DELIMITER_MESSAGE };

    // Exact duplicates are a no-op: failing would push the model into a retry loop.
    if (
      entries.some((entry) => entry.toLowerCase() === content.toLowerCase())
    ) {
      return {
        ok: true,
        message: "Already remembered — nothing changed.",
        entries,
      };
    }

    const next = [...entries, content];
    const overflow = wouldOverflow(next, target);

    if (overflow != null) return { ok: false, message: overflow };

    writeEntries(target, next);

    return { ok: true, message: "Remembered.", entries: next };
  }

  if (action === "replace") {
    const content = (input.content ?? "").trim();

    if (content.length === 0) {
      return {
        ok: false,
        message: "Nothing to replace it with — content was empty.",
      };
    }

    const long = tooLong(content, "replace");

    if (long != null) return { ok: false, message: long };
    if (containsDelimiter(content))
      return { ok: false, message: DELIMITER_MESSAGE };

    const { index, error } = findByFragment(entries, input.match ?? "");

    if (error != null) return { ok: false, message: error, entries };

    const next = [...entries];

    next[index] = content;

    // Swapping a short entry for a long one can overflow just as surely as adding.
    const overflow = wouldOverflow(next, target);

    if (overflow != null) return { ok: false, message: overflow };

    writeEntries(target, next);

    return { ok: true, message: "Updated.", entries: next };
  }

  const { index, error } = findByFragment(entries, input.match ?? "");

  if (error != null) return { ok: false, message: error, entries };

  const next = entries.filter((_, i) => i !== index);

  writeEntries(target, next);

  return { ok: true, message: "Forgotten.", entries: next };
};
