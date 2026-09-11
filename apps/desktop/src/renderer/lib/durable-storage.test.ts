import { describe, expect, it, vi } from "vitest";

import { createDurableStorage } from "./durable-storage";
import type { DurableStateApi } from "./durable-storage";

const fakeApi = (
  snapshot: Record<string, string> | null
): DurableStateApi & {
  cleared: number;
  removed: string[];
  written: [string, string][];
} => {
  const written: [string, string][] = [];
  const removed: string[] = [];
  const api = {
    cleared: 0,
    clear: () => {
      api.cleared += 1;
    },
    remove: (key: string) => {
      removed.push(key);
    },
    removed,
    set: (key: string, value: string) => {
      written.push([key, value]);
    },
    snapshot,
    written,
  };

  return api;
};

const fakeLocal = (entries: Record<string, string> = {}): Storage => {
  const state = new Map(Object.entries(entries));

  return {
    clear: () => state.clear(),
    getItem: (key: string) => state.get(key) ?? null,
    key: (index: number) => [...state.keys()][index] ?? null,
    get length() {
      return state.size;
    },
    removeItem: (key: string) => {
      state.delete(key);
    },
    setItem: (key: string, value: string) => {
      state.set(key, value);
    },
  };
};

describe("main-process backed storage", () => {
  it("serves the snapshot and writes through", () => {
    const api = fakeApi({ theme: "dark" });
    const storage = createDurableStorage(api, fakeLocal());

    expect(storage.getItem("theme")).toBe("dark");

    storage.setItem("lang", "de");
    expect(storage.getItem("lang")).toBe("de");
    expect(api.written).toContainEqual(["lang", "de"]);

    storage.removeItem("theme");
    expect(storage.getItem("theme")).toBeNull();
    expect(api.removed).toContain("theme");

    storage.clear();
    expect(storage.getItem("lang")).toBeNull();
    expect(api.cleared).toBe(1);
  });

  it("migrates the origin's localStorage once, without clobbering", () => {
    const api = fakeApi({ theme: "dark" });
    const local = fakeLocal({ draft: "hello", theme: "light" });
    const storage = createDurableStorage(api, local);

    // The legacy value comes over; a key the store already has wins.
    expect(storage.getItem("draft")).toBe("hello");
    expect(storage.getItem("theme")).toBe("dark");
    expect(storage.getItem("durable-storage.migrated")).toBe("1");

    // A later boot with the same snapshot does not migrate again.
    local.setItem("draft", "changed later");
    const again = createDurableStorage(
      fakeApi({
        "durable-storage.migrated": "1",
        draft: "hello",
        theme: "dark",
      }),
      local
    );

    expect(again.getItem("draft")).toBe("hello");
  });
});

describe("fallbacks", () => {
  it("uses localStorage when the shell has no store", () => {
    const local = fakeLocal({ theme: "dark" });
    const storage = createDurableStorage(undefined, local);

    expect(storage.getItem("theme")).toBe("dark");
    storage.setItem("lang", "de");
    expect(local.getItem("lang")).toBe("de");
    // No store, no migration marker.
    expect(local.getItem("durable-storage.migrated")).toBeNull();
  });

  it("uses localStorage when the store handed back no snapshot", () => {
    const api = fakeApi(null);
    const local = fakeLocal();
    const storage = createDurableStorage(api, local);

    storage.setItem("theme", "dark");
    expect(local.getItem("theme")).toBe("dark");
    expect(api.written).toHaveLength(0);
  });

  it("still works with no storage at all", () => {
    const storage = createDurableStorage(undefined, undefined);

    expect(storage.getItem("theme")).toBeNull();
    storage.setItem("theme", "dark");
    expect(storage.getItem("theme")).toBe("dark");
    storage.removeItem("theme");
    expect(storage.getItem("theme")).toBeNull();
  });

  it("migrates what it can when localStorage throws mid-scan", () => {
    const api = fakeApi({});
    const local = fakeLocal({ draft: "hello" });

    vi.spyOn(local, "key").mockImplementation(() => {
      throw new Error("storage gone");
    });

    const storage = createDurableStorage(api, local);

    expect(storage.getItem("durable-storage.migrated")).toBe("1");
  });
});
