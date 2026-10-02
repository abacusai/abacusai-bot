import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

import { readRendererStateFile, RendererStateStore } from "./renderer-state";

let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-state-"));
  file = path.join(directory, "renderer-state.json");
});

afterEach(() => {
  fs.rmSync(directory, { force: true, recursive: true });
});

describe("RendererStateStore", () => {
  it("persists what was set and reloads it", () => {
    const store = new RendererStateStore(file);

    store.set("theme", "dark");
    store.set("draft", "hello");
    store.set("draft", null);
    store.flushSync();

    const reloaded = new RendererStateStore(file);

    expect(reloaded.snapshot()).toEqual({ theme: "dark" });
  });

  it("starts empty from a corrupt file", () => {
    fs.writeFileSync(file, "{not json");

    expect(new RendererStateStore(file).snapshot()).toEqual({});
  });

  it("ignores non-string values in the file", () => {
    fs.writeFileSync(file, JSON.stringify({ good: "1", bad: 2 }));

    expect(new RendererStateStore(file).snapshot()).toEqual({ good: "1" });
  });

  it("drops a write past the size caps", () => {
    const store = new RendererStateStore(file);

    store.set("huge", "x".repeat(600 * 1024));

    expect(store.snapshot()).toEqual({});
  });

  it("clears everything", () => {
    const store = new RendererStateStore(file);

    store.set("theme", "dark");
    store.clear();
    store.flushSync();

    expect(new RendererStateStore(file).snapshot()).toEqual({});
  });

  it("frees the budget when keys are removed", () => {
    const store = new RendererStateStore(file);
    const chunk = "x".repeat(400 * 1024);

    // Ten writes of ~400KB fit a 4MB cap only if removals give bytes back.
    for (let index = 0; index < 10; index += 1) {
      store.set("big", chunk);
      store.set("big", null);
    }
    store.set("big", chunk);

    expect(store.snapshot()).toEqual({ big: chunk });
  });

  it("tells listeners about changes only, removals as null", () => {
    const store = new RendererStateStore(file);
    const seen: [string, string | null][] = [];
    const off = store.onSet((key, value) => seen.push([key, value]));

    store.set("theme", "dark");
    store.set("theme", "dark");
    store.set("gone", null);
    store.set("big", "x".repeat(600 * 1024));
    store.set("lang", "fr");
    store.set("theme", null);
    store.clear();
    off();
    store.set("theme", "light");

    expect(seen).toEqual([
      ["theme", "dark"],
      ["lang", "fr"],
      ["theme", null],
      ["lang", null],
    ]);
    expect(store.get("theme")).toBe("light");
    expect(store.get("lang")).toBeUndefined();
  });

  it("keeps working when a listener throws", () => {
    const store = new RendererStateStore(file);
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    store.onSet(() => {
      throw new Error("boom");
    });

    store.set("theme", "dark");

    expect(store.get("theme")).toBe("dark");
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });
});

describe("readRendererStateFile", () => {
  it("reads string entries only and tolerates a missing or corrupt file", () => {
    expect(readRendererStateFile(file).size).toBe(0);
    fs.writeFileSync(file, "{nope");
    expect(readRendererStateFile(file).size).toBe(0);
    fs.writeFileSync(file, "null");
    expect(readRendererStateFile(file).size).toBe(0);
    fs.writeFileSync(file, JSON.stringify({ theme: "dark", n: 1, o: {} }));
    expect(Object.fromEntries(readRendererStateFile(file))).toEqual({
      theme: "dark",
    });
  });

  it("throws for a file that exists but cannot be read; the store still starts empty", () => {
    // A directory in its place: EISDIR, as EACCES or EBUSY would be.
    fs.mkdirSync(file);
    expect(() => readRendererStateFile(file)).toThrow();
    expect(new RendererStateStore(file).snapshot()).toEqual({});
  });
});
