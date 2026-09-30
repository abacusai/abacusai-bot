/**
 * The startup wiring: `--rerun-migration=<id>` is read only by unpackaged
 * builds, and a runner failure resolves (launch is never blocked).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const electron = vi.hoisted(() => ({
  app: {
    isPackaged: false,
    getPath: (): string => "",
    getVersion: () => "1.0.0",
  },
  nativeTheme: { shouldUseDarkColors: false },
  BrowserWindow: class {},
}));

vi.mock("electron", () => electron);

const run = vi.hoisted(() => vi.fn());
vi.mock("./runner", () => ({ runMigrations: run }));

import { parseRerunArgs, runStartupMigrations } from "./startup";

let home: string;
const argv = process.argv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "startup-"));
  process.env.ABACUSAI_BOT_HOME = home;
  electron.app.getPath = () => path.join(home, "electron");
  run.mockReset();
  run.mockResolvedValue({ applied: [], failed: null, recovered: [] });
});

afterEach(() => {
  process.argv = argv;
  electron.app.isPackaged = false;
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("startup migrations", () => {
  it("parses --rerun-migration ids", () => {
    expect(
      parseRerunArgs([
        "electron",
        "--rerun-migration=2",
        "--rerun-migration=x",
        "--rerun-migration=10",
        "--other",
      ])
    ).toEqual([2, 10]);
  });

  it("passes rerun ids only when unpackaged", async () => {
    process.argv = [...argv, "--rerun-migration=2"];
    await runStartupMigrations("App");
    expect(run.mock.calls[0]?.[0]).toMatchObject({
      home,
      userData: path.join(home, "electron"),
      appVersion: "1.0.0",
      rerun: [2],
    });

    electron.app.isPackaged = true;
    await runStartupMigrations("App");
    expect(run.mock.calls[1]?.[0]).toMatchObject({ rerun: [] });
  });

  it("resolves when the runner throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run.mockRejectedValue(new Error("boom"));
    await expect(runStartupMigrations("App")).resolves.toBeNull();
    error.mockRestore();
  });
});
