/**
 * An installed app's saved data: one flat key/value file per app, on the
 * user's disk, apart from the app's code, so it outlives edits, updates and
 * reinstalls. Pages reach it two ways, both on the view's own IPC:
 *   - `localStorage`, which the preload backs with this store (strings), so a
 *     page written the usual way keeps its data;
 *   - `window.abacus.store` get/set/keys (any JSON value).
 * The chat preview and the installed window of one page share the store.
 *
 *   <root>/<id>/data/store.json        the data
 *   <root>/<id>/data/backups/<day>.json the data as it was before that day's
 *                                       first change; the last 7 days kept
 *   <root>/<id>/data/imported          the page's old localStorage was read in
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { WebContents } from "electron";

const MAX_KEY = 200;
const MAX_STORE_BYTES = 5 * 1024 * 1024;
const BACKUP_DAYS = 7;
const FLUSH_MS = 250;

let rootDir = "";
/** Set once by artifact-apps.ts: where installed apps keep their files. */
export const setStoreRoot = (root: string): void => {
  rootDir = root;
};

const dataDir = (id: string): string => join(rootDir, id, "data");
const storeFile = (id: string): string => join(dataDir(id), "store.json");
const importedFlag = (id: string): string => join(dataDir(id), "imported");

export const writeAtomic = (file: string, data: string | Buffer): void => {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, data);
  renameSync(tmp, file);
};

type Store = Record<string, unknown>;

/** Open stores, written behind: a page never waits on the disk. */
const cache = new Map<string, Store>();
const timers = new Map<string, NodeJS.Timeout>();

const load = (id: string): Store => {
  const hit = cache.get(id);
  if (hit) return hit;
  let store: Store = {};
  try {
    const parsed: unknown = JSON.parse(readFileSync(storeFile(id), "utf8"));
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed))
      store = parsed as Store;
  } catch {
    // No data yet, or unreadable: the day's backup still holds the last good copy.
  }
  cache.set(id, store);
  return store;
};

const backup = (id: string): void => {
  if (!existsSync(storeFile(id))) return;
  const dir = join(dataDir(id), "backups");
  const today = `${new Date().toISOString().slice(0, 10)}.json`;
  if (existsSync(join(dir, today))) return;
  mkdirSync(dir, { recursive: true });
  copyFileSync(storeFile(id), join(dir, today));
  const days = readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .sort();
  for (const old of days.slice(0, Math.max(0, days.length - BACKUP_DAYS)))
    rmSync(join(dir, old), { force: true });
};

const flush = (id: string): void => {
  clearTimeout(timers.get(id));
  timers.delete(id);
  const store = cache.get(id);
  if (!store) return;
  try {
    backup(id);
    writeAtomic(storeFile(id), JSON.stringify(store, null, 1));
  } catch (error) {
    console.error("[installed-app] could not save data", id, error);
  }
};

export const flushAllStores = (): void => {
  // A snapshot: flush deletes from the map it walks.
  // oxlint-disable-next-line unicorn/no-useless-spread
  for (const id of [...timers.keys()]) flush(id);
};

const validKey = (key: unknown): string => {
  if (typeof key !== "string" || key.length === 0 || key.length > MAX_KEY)
    throw new Error("A saved key is a string of 1 to 200 characters.");
  return key;
};

/** Every view showing a page with a store, by app id. */
const viewers = new Map<string, Set<WebContents>>();
/** Views whose page read data another view has changed since. */
const stale = new WeakSet<WebContents>();

/** Views the agent can drive too: the chat's browser, not an installed window. */
const agentReachable = new WeakSet<WebContents>();

/**
 * While the agent tests a page in its browser (`browser_task`), what each key
 * it changed held before, by app id. The agent's test rows ("Ada Blake, Boiler
 * service") are not the user's: when the run ends they are put back, so the
 * page still saves while the agent checks it, and the user's data stays theirs.
 */
let testRuns = 0;
const beforeTest = new Map<string, Map<string, unknown>>();

export const agentBrowserRunStarted = (): void => {
  testRuns += 1;
};

export const agentBrowserRunEnded = (): void => {
  testRuns = Math.max(0, testRuns - 1);
  if (testRuns > 0) return;
  for (const [id, keys] of beforeTest) {
    const store = load(id);
    for (const [key, value] of keys)
      if (value === undefined) delete store[key];
      else store[key] = value;
    flush(id);
    for (const view of viewers.get(id) ?? [])
      if (!view.isDestroyed()) view.reload();
  }
  beforeTest.clear();
};

const write = (id: string, from: WebContents, change: (s: Store) => void) => {
  const store = load(id);
  const before = JSON.stringify(store);
  const old = JSON.parse(before) as Store;
  change(store);
  const after = JSON.stringify(store);
  // A page that saves on load writes what is already there.
  if (after === before) return;
  if (Buffer.byteLength(after) > MAX_STORE_BYTES) {
    cache.set(id, old);
    throw new Error("This app's saved data is over 5 MB.");
  }
  if (testRuns > 0 && agentReachable.has(from)) {
    if (!beforeTest.has(id)) beforeTest.set(id, new Map());
    const kept = beforeTest.get(id)!;
    for (const key of new Set([...Object.keys(old), ...Object.keys(store)]))
      if (
        !kept.has(key) &&
        JSON.stringify(old[key]) !== JSON.stringify(store[key])
      )
        kept.set(key, old[key]);
  }
  clearTimeout(timers.get(id));
  timers.set(
    id,
    setTimeout(() => flush(id), FLUSH_MS)
  );
  // Other views of the same page reload when the user comes back to them, so
  // neither keeps a stale copy that would overwrite the other's rows.
  for (const other of viewers.get(id) ?? [])
    if (other !== from) stale.add(other);
};

/**
 * Serves the store on `contents`' own IPC. `idOf` names the app the view's
 * page belongs to right now (from its URL), or null: a view showing anything
 * else gets nothing, and the id is never taken from the page.
 */
export const serveStore = (
  contents: WebContents,
  idOf: (url: string) => string | null,
  mayImport: (url: string) => boolean,
  agentCanDrive: boolean
): void => {
  if (agentCanDrive) agentReachable.add(contents);
  let current: string | null = null;
  const track = (id: string | null): void => {
    if (id === current) return;
    if (current != null) viewers.get(current)?.delete(contents);
    current = id;
    if (id != null) {
      if (!viewers.has(id)) viewers.set(id, new Set());
      viewers.get(id)!.add(contents);
    }
  };
  contents.once("destroyed", () => track(null));
  contents.on("focus", () => {
    if (!stale.has(contents)) return;
    stale.delete(contents);
    contents.reload();
  });
  const appOf = (
    event: Electron.IpcMainEvent | Electron.IpcMainInvokeEvent
  ) => {
    // The top page only: an iframe inside it is someone else's.
    if (event.senderFrame == null || event.senderFrame !== contents.mainFrame)
      return null;
    const id = idOf(event.senderFrame.url);
    track(id);
    return id;
  };
  const need = (id: string | null): string => {
    if (id == null) throw new Error("This page has no saved data.");
    return id;
  };

  // The page's start: its localStorage as the store holds it (null: not a
  // page with a store). The first time, what the page had kept in its own
  // localStorage is read in.
  contents.ipc.on("artifact-app:ls-load", (event, native: unknown) => {
    const id = appOf(event);
    if (id == null) {
      event.returnValue = null;
      return;
    }
    stale.delete(contents);
    try {
      if (!existsSync(importedFlag(id))) {
        if (mayImport(event.senderFrame!.url))
          importLocalStorage(id, native, contents);
        writeAtomic(importedFlag(id), "");
      }
    } catch (error) {
      console.warn("[installed-app] import failed", id, error);
    }
    const strings: Record<string, string> = {};
    for (const [key, value] of Object.entries(load(id)))
      if (typeof value === "string") strings[key] = value;
    event.returnValue = strings;
  });
  contents.ipc.on("artifact-app:ls-set", (event, key: unknown, value) => {
    const id = appOf(event);
    if (id == null) return;
    try {
      write(id, contents, (store) => {
        if (value === null) delete store[validKey(key)];
        else store[validKey(key)] = String(value);
      });
    } catch (error) {
      console.warn("[installed-app]", (error as Error).message);
    }
  });
  contents.ipc.on("artifact-app:ls-clear", (event) => {
    const id = appOf(event);
    if (id == null) return;
    write(id, contents, (store) => {
      for (const key of Object.keys(store))
        if (typeof store[key] === "string") delete store[key];
    });
  });
  contents.ipc.handle("artifact-app:store-get", (event, key: unknown) => {
    const value = load(need(appOf(event)))[validKey(key)];
    return value === undefined ? null : value;
  });
  contents.ipc.handle("artifact-app:store-keys", (event) =>
    Object.keys(load(need(appOf(event))))
  );
  contents.ipc.handle(
    "artifact-app:store-set",
    (event, key: unknown, value: unknown) => {
      const id = need(appOf(event));
      write(id, contents, (store) => {
        if (value === null || value === undefined) delete store[validKey(key)];
        else
          store[validKey(key)] = JSON.parse(JSON.stringify(value)) as unknown;
      });
    }
  );
};

/** A page's old localStorage, read in once; what the store already has wins. */
export const importLocalStorage = (
  id: string,
  native: unknown,
  from: WebContents | null
): void => {
  if (native == null || typeof native !== "object") return;
  const entries = Object.entries(native as Record<string, unknown>).filter(
    ([key, value]) =>
      typeof value === "string" && key.length > 0 && key.length <= MAX_KEY
  );
  if (entries.length === 0) return;
  const store = load(id);
  if (entries.every(([key]) => key in store)) return;
  const apply = (s: Store) => {
    for (const [key, value] of entries) if (!(key in s)) s[key] = value;
  };
  if (from) write(id, from, apply);
  else {
    apply(store);
    flush(id);
  }
};

export const markImported = (id: string): void =>
  writeAtomic(importedFlag(id), "");
export const wasImported = (id: string): boolean =>
  existsSync(importedFlag(id));

/** Removes an app's data for good (uninstall, "Also delete its data"). */
export const deleteStore = (id: string): void => {
  clearTimeout(timers.get(id));
  timers.delete(id);
  cache.delete(id);
  rmSync(dataDir(id), { recursive: true, force: true });
};

// ---- Export ------------------------------------------------------------------

const parsed = (value: unknown): unknown => {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
};

/** The data as JSON, string values that hold JSON opened up. */
export const exportJson = (id: string): string => {
  flush(id);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(load(id))) out[key] = parsed(value);
  return `${JSON.stringify(out, null, 2)}\n`;
};

const csvCell = (value: unknown): string => {
  const text =
    value == null
      ? ""
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

/**
 * The data as a table: the longest list of records the app keeps (its rows),
 * one column per field; with no such list, one row per key.
 */
export const exportCsv = (id: string): string => {
  let rows: Array<Record<string, unknown>> | null = null;
  const values = Object.values(load(id)).map(parsed);
  const lists = [
    ...values,
    ...values.flatMap((v) =>
      v && typeof v === "object" && !Array.isArray(v) ? Object.values(v) : []
    ),
  ];
  for (const value of lists)
    if (
      Array.isArray(value) &&
      value.length > (rows?.length ?? 0) &&
      value.every((r) => r && typeof r === "object" && !Array.isArray(r))
    )
      rows = value as Array<Record<string, unknown>>;
  if (rows == null) {
    const lines = Object.entries(load(id)).map(
      ([key, value]) => `${csvCell(key)},${csvCell(parsed(value))}`
    );
    return `${["key,value", ...lines].join("\r\n")}\r\n`;
  }
  const columns = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const lines = rows.map((r) => columns.map((c) => csvCell(r[c])).join(","));
  return `﻿${[columns.map(csvCell).join(","), ...lines].join("\r\n")}\r\n`;
};
