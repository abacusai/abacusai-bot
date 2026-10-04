/**
 * The runner as `main/index.ts` calls it: inside `whenReady`, after the
 * single-instance lock, before any service reads the migrated files. Never
 * throws and never blocks launch (spec 00 C.1).
 *
 * When a commit attempt is left unresolved (`RunMigrationsResult.unresolved`)
 * the app still starts, but writers must stay off the files it may cover
 * until a later launch settles it: `isMigrationWriteBlocked(file)`
 * (`write-block.ts`) says which.
 * `prefs.json` is the one such file main writes today; it is served from a
 * session-only copy instead (`prefsFileAfterMigrations`).
 */
import fs from "node:fs";
import path from "node:path";

import { app, nativeTheme } from "electron";

import { abacusBotHome } from "../paths";
import { readRendererStateFile } from "../services/config/renderer-state";
import { WINDOW_SURFACE } from "../window-chrome-options";
import {
  createMigrationProgress,
  openProgressWindow,
  type MigrationProgress,
} from "./progress-window";
import { runMigrations, type RunMigrationsResult } from "./runner";
import { MIGRATION_STEPS } from "./steps";
import {
  isMigrationWriteBlocked,
  setMigrationWriteBlocks,
} from "./write-block";

/** `--rerun-migration=<id>`, repeatable. */
export const parseRerunArgs = (argv: readonly string[]): number[] =>
  argv.flatMap((arg) => {
    const match = /^--rerun-migration=(\d+)$/.exec(arg);
    return match == null ? [] : [Number(match[1])];
  });

let progress: MigrationProgress | null = null;

/**
 * The progress window follows the theme the user chose in the old UI (its
 * `theme` key), not only the OS: nothing has applied the stored theme yet.
 */
export const progressWindowDark = (userData: string): boolean => {
  let theme: string | undefined;
  try {
    theme = readRendererStateFile(
      path.join(userData, "renderer-state.json")
    ).get("theme");
  } catch {
    theme = undefined;
  }
  if (theme === "dark") return true;
  if (theme === "light") return false;
  return nativeTheme.shouldUseDarkColors;
};

export const runStartupMigrations = async (
  appName: string
): Promise<RunMigrationsResult | null> => {
  const userData = app.getPath("userData");
  const dark = progressWindowDark(userData);
  if (import.meta.env.ABACUS_WEB_HOST !== true)
    progress = createMigrationProgress({
      open: () =>
        openProgressWindow({
          appName,
          dark,
          backgroundColor: dark ? WINDOW_SURFACE.dark : WINDOW_SURFACE.light,
        }),
    });
  try {
    const result = await runMigrations({
      home: abacusBotHome(),
      userData,
      appVersion: app.getVersion(),
      steps: MIGRATION_STEPS,
      // A development-only lever: a shipped build never re-runs a step.
      rerun: app.isPackaged ? [] : parseRerunArgs(process.argv),
      onProgress: (done, total, label) => progress?.report(done, total, label),
      log: (message) => console.log(`[migrations] ${message}`),
    });
    setMigrationWriteBlocks(result);
    for (const attempt of result.unresolved)
      console.error(
        `[migrations] unresolved commit in ${attempt.staging}; writes to ${
          attempt.destinations == null
            ? "every migrated file"
            : attempt.destinations.join(", ")
        } are held for this launch: ${attempt.error}`
      );
    return result;
  } catch (error) {
    console.error("[migrations] runner failed", error);
    return null;
  } finally {
    // Off screen now, before the main window is created.
    progress?.finish();
  }
};

/**
 * The file the prefs store should use this launch: `prefsFile` itself, or,
 * while an unresolved commit may cover it, a session-only copy in the temp
 * directory (seeded from it), so the UI keeps working and nothing it saves
 * can be overwritten by, or defeat, the next launch's rollback. Null means
 * memory only (the copy could not be made).
 */
export const prefsFileAfterMigrations = (
  prefsFile: string,
  tempDir: string = app.getPath("temp")
): string | null => {
  if (!isMigrationWriteBlocked(prefsFile)) return prefsFile;
  const overlay = path.join(
    tempDir,
    `abacusai-bot-prefs.${process.pid}.session.json`
  );
  try {
    fs.mkdirSync(tempDir, { recursive: true });
    try {
      fs.copyFileSync(prefsFile, overlay);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      fs.rmSync(overlay, { force: true });
    }
    console.error(
      `[migrations] prefs.json is held by an unresolved commit; this session's changes go to ${overlay}`
    );
    return overlay;
  } catch (error) {
    console.error(
      "[migrations] prefs.json is held and no session copy could be made; prefs stay in memory",
      error
    );
    return null;
  }
};

/**
 * Frees the progress window. Called once the main window exists (destroying
 * the only window would fire `window-all-closed`, which quits on Windows and
 * Linux), when the startup chain fails, and on `before-quit` (the window
 * refuses to close by itself). Safe to call more than once.
 */
export const disposeMigrationProgress = (): void => {
  progress?.dispose();
  progress = null;
};

/** Tests only. */
export const resetStartupMigrationsForTest = (
  result: RunMigrationsResult | null = null
): void => {
  setMigrationWriteBlocks(result);
  progress = null;
};
