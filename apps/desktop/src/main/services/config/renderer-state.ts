/**
 * Durable key-value state for the renderer, owned by the main process. Each
 * renderer is served from its own origin (the version rides the app://
 * hostname), so localStorage resets on every renderer swap; this file in
 * userData does not. Renderer-side face: `renderer/lib/durable-storage.ts`.
 */
import fs from "node:fs";
import path from "node:path";

import { app, ipcMain } from "electron";

/** Writes past either cap are dropped with a warning. */
const MAX_VALUE_BYTES = 512 * 1024;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const WRITE_DELAY_MS = 500;

const byteLength = (value: string): number => Buffer.byteLength(value, "utf8");

export class RendererStateStore {
  #dirty = false;
  #state = new Map<string, string>();
  #timer: NodeJS.Timeout | undefined;
  #totalBytes = 0;
  readonly #file: string;

  constructor(file: string) {
    this.#file = file;

    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf-8")) as unknown;

      if (typeof raw === "object" && raw !== null) {
        for (const [key, value] of Object.entries(raw)) {
          if (typeof value === "string") {
            this.#state.set(key, value);
            this.#totalBytes += byteLength(key) + byteLength(value);
          }
        }
      }
    } catch {
      // Missing or corrupt: start empty.
    }
  }

  snapshot(): Record<string, string> {
    return Object.fromEntries(this.#state);
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

    this.#state.set(key, value);
    this.#totalBytes += nextBytes - previousBytes;
    this.#scheduleWrite();
  }

  clear(): void {
    if (this.#state.size === 0) return;

    this.#state.clear();
    this.#totalBytes = 0;
    // Not debounced: delete-all-data erases userData right after this.
    this.#dirty = true;
    this.flushSync();
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

  ipcMain.on("renderer-state:snapshot", (event) => {
    event.returnValue = store.snapshot();
  });
  ipcMain.on("renderer-state:set", (_event, key: unknown, value: unknown) => {
    if (typeof key !== "string") return;

    if (value === null) store.set(key, null);
    else if (typeof value === "string") store.set(key, value);
  });
  ipcMain.on("renderer-state:clear", () => {
    store.clear();
  });
  app.on("before-quit", () => {
    store.flushSync();
  });

  return store;
};
