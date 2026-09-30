/**
 * The `memories` table (spec 00 B.2): one row per remembered entry, global
 * (`memories/*.md`) and per bot (`bots/<id>/MEMORY.md`), plus the watchers
 * that notice the agent child writing those files itself.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import type { MemoryRow } from "#shared/contract/rows";
import type { MemoryTargetId } from "#shared/contracts";

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

/**
 * Flat `fs.watch`ers (no recursive watch on Linux) over every directory whose
 * files feed `memories` or `memory.bots`: the home (for `memories/` and
 * `bots/` appearing), `memories/`, `bots/`, each `bots/<id>/` (its
 * `MEMORY.md`) and each `bots/<id>/memory/` (daily notes). Every event
 * re-reconciles the set, so a bot directory created or removed adds or drops
 * its watchers, and an editor's rename-replace re-arms. Changes are debounced
 * into one `onChange`.
 */
export class MemoryWatchers {
  readonly #home: string;
  readonly #onChange: () => void;
  readonly #debounceMs: number;
  readonly #watchers = new Map<string, fs.FSWatcher>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #closed = false;

  constructor(options: {
    home: string;
    onChange: () => void;
    debounceMs?: number;
  }) {
    this.#home = options.home;
    this.#onChange = options.onChange;
    this.#debounceMs = options.debounceMs ?? MEMORY_DEBOUNCE_MS;
    this.#reconcile();
  }

  /** The directories being watched (tests). */
  watchedPaths(): string[] {
    return Array.from(this.#watchers.keys()).sort();
  }

  close(): void {
    this.#closed = true;
    if (this.#timer != null) clearTimeout(this.#timer);
    this.#timer = null;
    for (const watcher of this.#watchers.values()) watcher.close();
    this.#watchers.clear();
  }

  #desired(): Map<string, (name: string | null) => boolean> {
    const any = (): boolean => true;
    const memories = path.join(this.#home, "memories");
    const bots = path.join(this.#home, "bots");
    const wanted = new Map<string, (name: string | null) => boolean>([
      // Only the two directories matter here, not every store in the home.
      [
        this.#home,
        (name) => name == null || name === "memories" || name === "bots",
      ],
      [memories, any],
      [bots, any],
    ]);
    for (const id of this.#subdirectories(bots)) {
      const dir = path.join(bots, id);
      wanted.set(
        dir,
        (name) => name == null || name === "MEMORY.md" || name === "memory"
      );
      wanted.set(path.join(dir, "memory"), any);
    }
    for (const dir of Array.from(wanted.keys()))
      if (!isDirectory(dir)) wanted.delete(dir);
    return wanted;
  }

  #subdirectories(dir: string): string[] {
    try {
      return fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch {
      return [];
    }
  }

  #reconcile(): void {
    if (this.#closed) return;
    const wanted = this.#desired();
    for (const [dir, watcher] of this.#watchers)
      if (!wanted.has(dir)) {
        watcher.close();
        this.#watchers.delete(dir);
      }
    for (const [dir, relevant] of wanted) {
      if (this.#watchers.has(dir)) continue;
      try {
        const watcher = fs.watch(dir, { persistent: false }, (_event, name) => {
          if (relevant(name == null ? null : String(name))) this.#changed();
        });
        watcher.on("error", () => {
          watcher.close();
          if (this.#watchers.get(dir) === watcher) this.#watchers.delete(dir);
          this.#changed();
        });
        this.#watchers.set(dir, watcher);
      } catch {
        // Gone between the check and the watch; the next event re-arms.
      }
    }
  }

  #changed(): void {
    if (this.#closed || this.#timer != null) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      this.#reconcile();
      this.#onChange();
    }, this.#debounceMs);
  }
}

const isDirectory = (dir: string): boolean => {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
};
