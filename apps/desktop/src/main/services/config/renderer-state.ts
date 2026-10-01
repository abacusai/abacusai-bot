/**
 * Durable key-value state for the renderer, owned by the main process. Each
 * renderer is served from its own origin (the version rides the app://
 * hostname), so localStorage resets on every renderer swap; this file in
 * userData does not. Renderer-side face: `renderer/lib/durable-storage.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { app } from "electron";

/** Writes past either cap are dropped with a warning. */
const MAX_VALUE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const WRITE_DELAY_MS = 500;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

/**
 * The file's string entries; anything else in it is ignored. A missing or
 * corrupt file reads as empty. A file that exists but cannot be read
 * (EACCES, EBUSY) throws: the prefs migration (spec 00 C.4) must then fail
 * and retry, not record an import of nothing. The store itself still starts
 * empty in that case, as it always has.
 */
export const readRendererStateFile = (file: string): Map<string, string> => {
  const state = new Map<string, string>();

  let text: string;
  try {
    text = fs.readFileSync(file, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return state;
    throw error;
  }

  try {
    const raw = JSON.parse(text) as unknown;

    if (typeof raw === "object" && raw !== null) {
      for (const [key, value] of Object.entries(raw)) {
        if (typeof value === "string") state.set(key, value);
      }
    }
  } catch {
    // Missing or corrupt: start empty.
  }

  return state;
};

/**
 * Told after a key changes; `null` means removed (`set(key, null)` or
 * `clear()`). The transition-only legacy prefs sync (spec 00 C.4) listens.
 */
export type RendererStateListener = (key: string, value: string | null) => void;

export class RendererStateStore {
  #dirty = false;
  #state: Map<string, string>;
  #timer: NodeJS.Timeout | undefined;
  #totalBytes = 0;
  readonly #file: string;
  readonly #listeners = new Set<RendererStateListener>();

  constructor(file: string) {
    this.#file = file;
    try {
      this.#state = readRendererStateFile(file);
    } catch {
      // Unreadable: start empty, as before.
      this.#state = new Map();
    }

    for (const [key, value] of this.#state) {
      this.#totalBytes += byteLength(key) + byteLength(value);
    }
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#state);
  }

  get(key: string): string | undefined {
    return this.#state.get(key);
  }

  /** Called after each change that took effect, never for a no-op write. */
  onSet(listener: RendererStateListener): () => void {
    this.#listeners.add(listener);

    return () => {
      this.#listeners.delete(listener);
    };
  }

  set(key: string, value: string | null): void {
    const previous = this.#state.get(key);
    const previousBytes =
      previous === undefined ? 0 : byteLength(key) + byteLength(previous);

    if (value === null) {
      if (previous === undefined) return;

      this.#state.delete(key);
      this.#totalBytes -= previousBytes;
      this.#scheduleWrite();
      this.#notify(key, null);

      return;
    }

    const nextBytes = byteLength(key) + byteLength(value);

    if (
      nextBytes > MAX_VALUE_BYTES ||
      this.#totalBytes - previousBytes + nextBytes > MAX_TOTAL_BYTES
    ) {
      console.warn(
        `[renderer-state] dropping oversized write for ${key} (${nextBytes} bytes)`
      );

      return;
    }

    const changed = previous !== value;
    this.#state.set(key, value);
    this.#totalBytes += nextBytes - previousBytes;
    this.#scheduleWrite();
    if (changed) this.#notify(key, value);
  }

  clear(): void {
    if (this.#state.size === 0) return;

    const removed = Array.from(this.#state.keys());
    this.#state.clear();
    this.#totalBytes = 0;
    // Not debounced: a clear is rare and callers expect it on disk at once.
    this.#dirty = true;
    this.flushSync();
    for (const key of removed) this.#notify(key, null);
  }

  /** Write pending state now; called on quit, when the debounce cannot. */
  flushSync(): void {
    if (!this.#dirty) return;

    if (this.#timer !== undefined) {
      clearTimeout(this.#timer);
      this.#timer = undefined;
    }

    const temporary = `${this.#file}.tmp`;

    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      fs.writeFileSync(temporary, JSON.stringify(this.snapshot()), {
        mode: 0o600,
      });
      fs.renameSync(temporary, this.#file);
      this.#dirty = false;
    } catch (error) {
      console.error("[renderer-state] write failed", error);
    }
  }

  #notify(key: string, value: string | null): void {
    for (const listener of Array.from(this.#listeners)) {
      try {
        listener(key, value);
      } catch (error) {
        console.error("[renderer-state] listener threw", error);
      }
    }
  }

  #scheduleWrite(): void {
    this.#dirty = true;

    if (this.#timer !== undefined) return;

    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.flushSync();
    }, WRITE_DELAY_MS);
    this.#timer.unref();
  }
}

/**
 * Create the store and its IPC face. The snapshot channel is synchronous so
 * the preload has the state before the first renderer module runs.
 */
export const registerRendererState = (): RendererStateStore => {
  const store = new RendererStateStore(
    path.join(app.getPath("userData"), "renderer-state.json")
  );

  app.on("before-quit", () => {
    store.flushSync();
  });

  return store;
};
