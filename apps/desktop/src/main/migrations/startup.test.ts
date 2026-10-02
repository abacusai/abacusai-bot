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
  ipcMain: {},
}));

vi.mock("electron", () => electron);

const run = vi.hoisted(() => vi.fn());
vi.mock("./runner", async (original) => ({
  ...(await original<typeof import("./runner")>()),
  runMigrations: run,
}));

import {
  disposeMigrationProgress,
  parseRerunArgs,
  prefsFileAfterMigrations,
  progressWindowDark,
  resetStartupMigrationsForTest,
  runStartupMigrations,
} from "./startup";
import { isMigrationWriteBlocked } from "./write-block";

let home: string;
const argv = process.argv;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "startup-"));
  process.env.ABACUSAI_BOT_HOME = home;
  electron.app.getPath = () => path.join(home, "electron");
  run.mockReset();
  run.mockResolvedValue({
    applied: [],
    partial: [],
    failed: null,
    recovered: [],
    unresolved: [],
  });
  resetStartupMigrationsForTest();
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

  it("serves prefs from a session copy only while an unresolved commit covers prefs.json", async () => {
    const prefs = path.join(home, "prefs.json");
    fs.writeFileSync(prefs, "REAL");
    const temp = path.join(home, "tmp");
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    await runStartupMigrations("App");
    expect(isMigrationWriteBlocked(prefs)).toBe(false);
    expect(prefsFileAfterMigrations(prefs, temp)).toBe(prefs);

    run.mockResolvedValue({
      applied: [],
      failed: { id: 2, name: "x", error: "recovery failed" },
      recovered: [],
      unresolved: [
        {
          staging: "s",
          id: 2,
          name: "prefs-from-renderer-state",
          destinations: [prefs],
          error: "rollback failed",
        },
      ],
    });
    await runStartupMigrations("App");
    expect(isMigrationWriteBlocked(prefs)).toBe(true);
    expect(isMigrationWriteBlocked(path.join(home, "other.json"))).toBe(false);
    const session = prefsFileAfterMigrations(prefs, temp);
    expect(session).not.toBe(prefs);
    expect(fs.readFileSync(session ?? "", "utf8")).toBe("REAL");
    fs.writeFileSync(session ?? "", "SESSION");
    expect(fs.readFileSync(prefs, "utf8")).toBe("REAL");

    // Unknown destinations (an unreadable journal) block everything.
    run.mockResolvedValue({
      applied: [],
      failed: null,
      recovered: [],
      unresolved: [
        { staging: "s", id: null, name: null, destinations: null, error: "" },
      ],
    });
    await runStartupMigrations("App");
    expect(isMigrationWriteBlocked(path.join(home, "anything"))).toBe(true);
    error.mockRestore();
  });

  it("colours the progress window from the old UI's theme, else the OS", () => {
    const userData = path.join(home, "electron");
    fs.mkdirSync(userData, { recursive: true });
    const state = path.join(userData, "renderer-state.json");
    electron.nativeTheme.shouldUseDarkColors = false;
    expect(progressWindowDark(userData)).toBe(false);
    fs.writeFileSync(state, JSON.stringify({ theme: "dark" }));
    expect(progressWindowDark(userData)).toBe(true);
    electron.nativeTheme.shouldUseDarkColors = true;
    fs.writeFileSync(state, JSON.stringify({ theme: "light" }));
    expect(progressWindowDark(userData)).toBe(false);
    fs.writeFileSync(state, JSON.stringify({ theme: "system" }));
    expect(progressWindowDark(userData)).toBe(true);
    electron.nativeTheme.shouldUseDarkColors = false;
  });

  it("disposing the progress window is safe before, after and twice", async () => {
    disposeMigrationProgress();
    await runStartupMigrations("App");
    disposeMigrationProgress();
    disposeMigrationProgress();
  });

  it("resolves when the runner throws", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    run.mockRejectedValue(new Error("boom"));
    await expect(runStartupMigrations("App")).resolves.toBeNull();
    error.mockRestore();
  });
});
