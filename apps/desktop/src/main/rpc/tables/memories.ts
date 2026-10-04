/**
 * The `memories` table (spec 00 B.2): one row per remembered entry, global
 * (`memories/*.md`) and per bot (`bots/<id>/MEMORY.md`), plus the watchers
 * that notice the agent child writing those files itself.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MemoryRow } from "@abacus-ai/contract/contract/rows";
import type { MemoryTargetId } from "@abacus-ai/contract/contracts";

import type { TableSources } from "./sources";

/** In the order the Memory page lists them. */
const GLOBAL_TARGETS: MemoryTargetId[] = ["remember", "memory", "user"];

const entryHash = (entry: string): string =>
  createHash("sha256").update(entry).digest("hex").slice(0, 16);

/**
 * `${scope}:${botId ?? target}:${sha256(entry).slice(0, 16)}:${n}`, where `n`
 * counts earlier identical entries in the same list. Removing an earlier,
 * different entry changes only `index` (an update), never the id.
 */
const listRows = (
  entries: string[],
  row: (entry: string, index: number) => Omit<MemoryRow, "id" | "occurrences">,
  prefix: string
): MemoryRow[] => {
  const seen = new Map<string, number>();
  const total = new Map<string, number>();
  for (const entry of entries) total.set(entry, (total.get(entry) ?? 0) + 1);
  return entries.map((entry, index) => {
    const hash = entryHash(entry);
    const n = seen.get(hash) ?? 0;
    seen.set(hash, n + 1);
    return {
      id: `${prefix}:${hash}:${n}`,
      ...row(entry, index),
      occurrences: total.get(entry) ?? 1,
    };
  });
};

export const readMemoryRows = (sources: TableSources): MemoryRow[] => {
  const global = sources.listMemories();
  const rows: MemoryRow[] = [];
  for (const target of GLOBAL_TARGETS)
    rows.push(
      ...listRows(
        global[target] ?? [],
        (entry, index) => ({
          scope: "global",
          target,
          botId: null,
          botName: null,
          index,
          entry,
        }),
        `global:${target}`
      )
    );
  for (const view of sources.listBotMemories())
    rows.push(
      ...listRows(
        view.entries,
        (entry, index) => ({
          scope: "bot",
          target: null,
          botId: view.botId,
          botName: view.name,
          index,
          entry,
        }),
        `bot:${view.botId}`
      )
    );
  return rows;
};

export const MEMORY_DEBOUNCE_MS = 150;
/** Retry delays after a watcher could not be created on an existing directory. */
const ARM_RETRY_MS = [250, 1_000, 4_000];

/** What the watchers need of a directory watch: a way to stop it. */
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
  handle: WatchHandle;
  identity: string;
}

/**
 * Flat directory watchers (no recursive watch on Linux) over every directory
 * whose files feed `memories` or `memory.bots`: the home (for `memories/` and
 * `bots/` appearing), `memories/`, `bots/`, each `bots/<id>/` (its
 * `MEMORY.md`) and each `bots/<id>/memory/` (daily notes). Every event
 * re-reconciles the set, so a bot directory created or removed adds or drops
 * its watchers, and an editor's rename-replace re-arms.
 *
 * A watcher follows an inode, not a path, and APFS reuses inodes, so identity
 * (`dev:ino`) alone cannot tell a replaced directory from the original: a
 * `rename` event naming a watched child of a watched directory also forces
 * that child to be re-armed. A watcher only sees changes after it starts, so
 * whenever a reconcile armed something new one more settle pass runs, which
 * re-reads and notifies, to cover writes that landed between the directory
 * appearing and its watcher going live. A directory that exists but cannot be
 * watched (EPERM, ENOENT race) is retried with a bounded backoff. A home that
 * does not exist yet is waited for from its parent. Changes are debounced
 * into one `onChange`.
 */
export class MemoryWatchers {
  readonly #home: string;
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  readonly #watch: WatchFactory;
  readonly #watchers = new Map<string, Armed>();
  /** Directories whose `rename` was seen by their parent: re-arm them. */
  readonly #stale = new Set<string>();
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

  /** The directories being watched (tests). */
  watchedPaths(): string[] {
    return Array.from(this.#watchers.keys()).sort();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer != null) clearTimeout(this.#timer);
    if (this.#retryTimer != null) clearTimeout(this.#retryTimer);
    this.#timer = null;
    this.#retryTimer = null;
    for (const { handle } of this.#watchers.values()) handle.close();
    this.#watchers.clear();
  }

  /** Each wanted directory that exists: its event filter and identity. */
  #desired(): Map<string, { relevant: Relevant; identity: string }> {
    const any = (): boolean => true;
    const home = this.#home;
    const bots = path.join(home, "bots");
    const wanted = new Map<string, Relevant>();
    if (identityOf(home) == null) {
      // Not created yet (a fresh profile): wait for it from its parent.
      const name = path.basename(home);
      wanted.set(
        path.dirname(home),
        (event) => event == null || event === name
      );
    }
    // Only the two directories matter here, not every store in the home.
    wanted.set(
      home,
      (name) => name == null || name === "memories" || name === "bots"
    );
    wanted.set(path.join(home, "memories"), any);
    wanted.set(bots, any);
    for (const id of subdirectories(bots)) {
      const dir = path.join(bots, id);
      wanted.set(
        dir,
        (name) => name == null || name === "MEMORY.md" || name === "memory"
      );
      wanted.set(path.join(dir, "memory"), any);
    }
    const present = new Map<string, { relevant: Relevant; identity: string }>();
    for (const [dir, relevant] of wanted) {
      const identity = identityOf(dir);
      if (identity != null) present.set(dir, { relevant, identity });
    }
    return present;
  }

  /** Returns whether a watcher was newly armed. */
  #reconcile(): boolean {
    if (this.#closed) return false;
    const wanted = this.#desired();
    for (const [dir, armed] of this.#watchers) {
      // Gone, another directory at the path, or renamed under its parent.
      if (
        this.#stale.has(dir) ||
        wanted.get(dir)?.identity !== armed.identity
      ) {
        armed.handle.close();
        this.#watchers.delete(dir);
      }
    }
    this.#stale.clear();
    let armedNew = false;
    let failed = false;
    for (const [dir, { relevant, identity }] of wanted) {
      if (this.#watchers.has(dir)) continue;
      try {
        const handle: WatchHandle = this.#watch(
          dir,
          (event, name) => {
            if (event === "rename" && name != null)
              this.#stale.add(path.join(dir, name));
            if (relevant(name)) this.#changed();
          },
          () => {
            handle.close();
            if (this.#watchers.get(dir)?.handle === handle)
              this.#watchers.delete(dir);
            this.#changed();
          }
        );
        this.#watchers.set(dir, { handle, identity });
        armedNew = true;
      } catch {
        // EPERM, or gone between the check and the watch.
        failed = true;
      }
    }
    if (failed) this.#scheduleRetry();
    else this.#retries = 0;
    return armedNew;
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
      // Cover what landed before the new watchers went live.
      if (armedNew) this.#changed();
    }, this.#debounceMs);
  }
}

type Relevant = (name: string | null) => boolean;

const subdirectories = (dir: string): string[] => {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
};

/** `dev:ino` of a directory; null when it is missing or not a directory. */
const identityOf = (dir: string): string | null => {
  try {
    const stat = fs.statSync(dir);
    return stat.isDirectory() ? `${stat.dev}:${stat.ino}` : null;
  } catch {
    return null;
  }
};
