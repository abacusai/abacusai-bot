/**
 * The watcher behind the `memories` table and `memory.events`. Every change
 * to the memory folder, the agent's or the page's, is appended to
 * `memory/.history/` (packages/agent/src/memory/notes.ts `commit`), so that
 * one directory is all there is to watch.
 */
import fs from "node:fs";
import path from "node:path";

export const MEMORY_DEBOUNCE_MS = 150;
/** Retry delays after a watcher could not be created on an existing directory. */
const ARM_RETRY_MS = [250, 1_000, 4_000];

/** What the watcher needs of a directory watch: a way to stop it. */
export interface WatchHandle {
  close(): void;
}

/** The watch primitive; `fs.watch` by default, injectable so tests drive events. */
export type WatchFactory = (
  dir: string,
  listener: (event: string, name: string | null) => void,
  onError: (error: unknown) => void
) => WatchHandle;

export const fsWatchFactory: WatchFactory = (dir, listener, onError) => {
  const watcher = fs.watch(dir, { persistent: false }, (event, name) =>
    listener(event, name == null ? null : String(name))
  );
  watcher.on("error", onError);
  return watcher;
};

interface Armed {
  dir: string;
  handle: WatchHandle;
  identity: string;
}

/**
 * One flat watcher on `<home>/memory/.history`, or, until it exists, on its
 * deepest existing ancestor, filtered to the next name on the way down. Every
 * event re-reconciles, so the history appearing, or being replaced (another
 * `dev:ino`, or a `rename` naming the directory itself, since APFS reuses
 * inodes), moves the watcher. A watcher only sees changes after
 * it starts, so arming a new one runs one more settle pass. A directory that
 * cannot be watched (EPERM, ENOENT race) is retried with a bounded backoff.
 * Changes are debounced into one `onChange`.
 */
export class MemoryWatcher {
  readonly #home: string;
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  readonly #watch: WatchFactory;
  #armed: Armed | null = null;
  /** The watched directory reported its own removal: re-arm even on the same inode. */
  #stale = false;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #retries = 0;
  #closed = false;

  constructor(options: {
    home: string;
    onChange: () => void;
    debounceMs?: number;
    watch?: WatchFactory;
  }) {
    this.#home = options.home;
    this.#onChange = options.onChange;
    this.#debounceMs = options.debounceMs ?? MEMORY_DEBOUNCE_MS;
    this.#watch = options.watch ?? fsWatchFactory;
    // The OS may drop changes made while its first watcher is starting.
    if (this.#reconcile()) this.#changed();
  }

  /** The directory being watched (tests). */
  watchedPath(): string | null {
    return this.#armed?.dir ?? null;
  }

  close(): void {
    this.#closed = true;
    if (this.#timer != null) clearTimeout(this.#timer);
    if (this.#retryTimer != null) clearTimeout(this.#retryTimer);
    this.#timer = null;
    this.#retryTimer = null;
    this.#armed?.handle.close();
    this.#armed = null;
  }

  /** The directory to watch now, its identity and which events matter. */
  #desired(): {
    dir: string;
    identity: string;
    relevant: (name: string | null) => boolean;
  } | null {
    const history = path.join(this.#home, "memory", ".history");
    const chain = [
      path.dirname(this.#home),
      this.#home,
      path.dirname(history),
      history,
    ];
    for (let at = chain.length - 1; at >= 0; at -= 1) {
      const dir = chain[at]!;
      const identity = identityOf(dir);
      if (identity == null) continue;
      const next = chain[at + 1];
      return {
        dir,
        identity,
        relevant:
          next == null
            ? () => true
            : (name) => name == null || name === path.basename(next),
      };
    }
    return null;
  }

  /** Returns whether a watcher was newly armed. */
  #reconcile(): boolean {
    if (this.#closed) return false;
    const wanted = this.#desired();
    const armed = this.#armed;
    const stale = this.#stale;
    this.#stale = false;
    if (
      !stale &&
      armed != null &&
      wanted?.dir === armed.dir &&
      wanted.identity === armed.identity
    )
      return false;
    armed?.handle.close();
    this.#armed = null;
    if (wanted == null) return false;
    try {
      const handle: WatchHandle = this.#watch(
        wanted.dir,
        (event, name) => {
          if (event === "rename" && name === path.basename(wanted.dir))
            this.#stale = true;
          if (this.#stale || wanted.relevant(name)) this.#changed();
        },
        () => {
          handle.close();
          if (this.#armed?.handle === handle) this.#armed = null;
          this.#changed();
        }
      );
      this.#armed = { dir: wanted.dir, handle, identity: wanted.identity };
      this.#retries = 0;
      return true;
    } catch {
      // EPERM, or gone between the check and the watch.
      this.#scheduleRetry();
      return false;
    }
  }

  #scheduleRetry(): void {
    if (this.#retryTimer != null || this.#retries >= ARM_RETRY_MS.length)
      return;
    const delay = ARM_RETRY_MS[this.#retries++]!;
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#reconcile()) this.#changed();
    }, delay);
  }

  #changed(): void {
    if (this.#closed || this.#timer != null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      const armedNew = this.#reconcile();
      this.#onChange();
      // Cover what landed before the new watcher went live.
      if (armedNew) this.#changed();
    }, this.#debounceMs);
  }
}

/** `dev:ino` of a directory; null when it is missing or not a directory. */
const identityOf = (dir: string): string | null => {
  try {
    const stat = fs.statSync(dir);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
};
