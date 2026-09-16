/**
 * The one storage the renderer persists through. Each experience renderer
 * runs on its own origin, so localStorage resets on every swap; this is a
 * synchronous wrapper over main's renderer-state store, seeded from a preload
 * snapshot, falling back to localStorage on a shell without that store.
 * `state-guard.test.ts` bans direct localStorage/sessionStorage use.
 */

export interface DurableStateApi {
  clear: () => void;
  remove: (key: string) => void;
  set: (key: string, value: string) => void;
  snapshot: Record<string, string> | null;
}

export interface DurableStorage {
  clear(): void;
  getItem(key: string): string | null;
  removeItem(key: string): void;
  setItem(key: string, value: string): void;
}

/** Marks that the origin's localStorage was copied in once. */
const MIGRATED_KEY = "durable-storage.migrated";

class MainProcessStorage implements DurableStorage {
  readonly #api: DurableStateApi;
  readonly #state: Map<string, string>;

  constructor(api: DurableStateApi, snapshot: Record<string, string>) {
    this.#api = api;
    this.#state = new Map(Object.entries(snapshot));
  }

  clear(): void {
    this.#state.clear();
    this.#api.clear();
  }

  getItem(key: string): string | null {
    return this.#state.get(key) ?? null;
  }

  removeItem(key: string): void {
    this.#state.delete(key);
    this.#api.remove(key);
  }

  setItem(key: string, value: string): void {
    // Optimistic: the main store drops writes past its size caps, so an
    // oversized value lives only until the next renderer swap.
    this.#state.set(key, value);
    this.#api.set(key, value);
  }
}

const memoryStorage = (): DurableStorage => {
  const state = new Map<string, string>();

  return {
    clear: () => state.clear(),
    getItem: (key) => state.get(key) ?? null,
    removeItem: (key) => {
      state.delete(key);
    },
    setItem: (key, value) => {
      state.set(key, value);
    },
  };
};

const migrate = (storage: DurableStorage, local: Storage): void => {
  if (storage.getItem(MIGRATED_KEY) !== null) return;

  try {
    for (let index = 0; index < local.length; index += 1) {
      const key = local.key(index);

      if (key === null || storage.getItem(key) !== null) continue;

      const value = local.getItem(key);

      if (value !== null) storage.setItem(key, value);
    }
  } catch {
    // localStorage can be unavailable; migrate what could be read.
  }

  storage.setItem(MIGRATED_KEY, "1");
};

export const createDurableStorage = (
  api: DurableStateApi | undefined,
  local: Storage | undefined
): DurableStorage => {
  if (api?.snapshot != null) {
    const storage = new MainProcessStorage(api, api.snapshot);

    if (local !== undefined) migrate(storage, local);

    return storage;
  }

  return local ?? memoryStorage();
};

const localStorageOrUndefined = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export const durableStorage: DurableStorage = createDurableStorage(
  typeof window === "undefined" ? undefined : window.api?.durableState,
  localStorageOrUndefined()
);
