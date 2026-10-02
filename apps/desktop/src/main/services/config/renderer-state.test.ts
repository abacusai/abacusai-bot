import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: () => os.tmpdir(), on: vi.fn() },
  ipcMain: { on: vi.fn() },
}));

import { readRendererStateFile } from "./renderer-state";

let directory: string;
let file: string;

beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "renderer-state-"));
  file = path.join(directory, "renderer-state.json");
});

afterEach(() => {
  fs.rmSync(directory, { force: true, recursive: true });
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
  });
});
