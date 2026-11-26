/**
 * A page the agent made, shown in the chat preview or as an installed app:
 * its saved data lives in the app's store on disk (main: artifact-apps/store.ts),
 * not in this browser's storage, which a preview can lose and an installed
 * window does not share. Two ways in, one store:
 *   - `localStorage`, replaced in the page's own world by one the store backs:
 *     read once at start (sync), written behind (async), so a page written
 *     the usual way keeps its data and never waits on a write;
 *   - `window.abacus.store` get/set/keys, for any JSON value.
 * Main decides from the frame's URL whether the page has a store at all; on
 * any other page this does nothing.
 */
import { contextBridge, ipcRenderer } from "electron";

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

/** Runs in the page's world: must not close over anything. */
const replaceLocalStorage = (
  initial: Record<string, string>,
  set: (key: string, value: string | null) => void,
  clear: () => void
): void => {
  const data = new Map(Object.entries(initial));
  const api = {
    getItem: (key: unknown): string | null => data.get(String(key)) ?? null,
    setItem: (key: unknown, value: unknown): void => {
      const k = String(key);
      const v = String(value);
      if (data.get(k) === v) return;
      data.set(k, v);
      set(k, v);
    },
    removeItem: (key: unknown): void => {
      const k = String(key);
      if (!data.delete(k)) return;
      set(k, null);
    },
    clear: (): void => {
      if (data.size === 0) return;
      data.clear();
      clear();
    },
    key: (index: number): string | null => [...data.keys()][index] ?? null,
    get length(): number {
      return data.size;
    },
  };
  const own = (p: string | symbol): boolean =>
    typeof p === "symbol" || p in api;
  const storage = new Proxy(api, {
    get: (target, p) =>
      own(p) ? Reflect.get(target, p) : (data.get(String(p)) ?? undefined),
    set: (_target, p, value) => {
      if (own(p)) return false;
      api.setItem(p, value);
      return true;
    },
    deleteProperty: (_target, p) => {
      if (!own(p)) api.removeItem(p);
      return true;
    },
    has: (_target, p) => own(p) || data.has(String(p)),
    ownKeys: () => [...data.keys()],
    getOwnPropertyDescriptor: (_target, p) =>
      typeof p === "string" && data.has(p) && !own(p)
        ? {
            value: data.get(p),
            enumerable: true,
            configurable: true,
            writable: true,
          }
        : undefined,
  });
  Object.defineProperty(window, "localStorage", {
    configurable: true,
    enumerable: true,
    get: () => storage,
  });
};

export const installArtifactAppPreload = (): void => {
  const { protocol, hostname } = window.location;
  const ours =
    protocol === "abacus-app:" ||
    protocol === "file:" ||
    (protocol === "http:" && LOCAL_HOSTS.has(hostname));
  if (!ours) return;

  // What the page kept in this browser's own storage: main reads it in the
  // first time (a page made before its data moved to the store).
  const native: Record<string, string> = {};
  try {
    for (let i = 0; i < window.localStorage.length; i++) {
      const key = window.localStorage.key(i);
      if (key != null) native[key] = window.localStorage.getItem(key) ?? "";
    }
  } catch {
    // Storage refused (an opaque origin): nothing to read in.
  }
  const initial = ipcRenderer.sendSync(
    "artifact-app:ls-load",
    native
  ) as Record<string, string> | null;
  if (initial == null) return;

  contextBridge.exposeInMainWorld("abacus", {
    store: {
      get: (key: string): Promise<unknown> =>
        ipcRenderer.invoke("artifact-app:store-get", key),
      set: (key: string, value: unknown): Promise<void> =>
        ipcRenderer.invoke("artifact-app:store-set", key, value),
      keys: (): Promise<string[]> =>
        ipcRenderer.invoke("artifact-app:store-keys"),
    },
  });
  contextBridge.executeInMainWorld({
    func: replaceLocalStorage,
    args: [
      initial,
      (key: string, value: string | null) =>
        ipcRenderer.send("artifact-app:ls-set", key, value),
      () => ipcRenderer.send("artifact-app:ls-clear"),
    ],
  });
};
