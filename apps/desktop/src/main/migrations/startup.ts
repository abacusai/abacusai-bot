/**
 * The runner as `main/index.ts` calls it: inside `whenReady`, after the
 * single-instance lock, before any service reads the migrated files. Never
 * throws and never blocks launch (spec 00 C.1).
 */
import { app, nativeTheme } from "electron";

import { abacusBotHome } from "../paths";
import { WINDOW_SURFACE } from "../window-chrome-options";
import {
  createMigrationProgress,
  openProgressWindow,
  type MigrationProgress,
} from "./progress-window";
import { runMigrations, type RunMigrationsResult } from "./runner";
import { MIGRATION_STEPS } from "./steps";

/** `--rerun-migration=<id>`, repeatable. */
export const parseRerunArgs = (argv: readonly string[]): number[] =>
  argv.flatMap((arg) => {
    const match = /^--rerun-migration=(\d+)$/.exec(arg);
    return match == null ? [] : [Number(match[1])];
  });

let progress: MigrationProgress | null = null;

export const runStartupMigrations = async (
  appName: string
): Promise<RunMigrationsResult | null> => {
  const dark = nativeTheme.shouldUseDarkColors;
  progress = createMigrationProgress({
    open: () =>
      openProgressWindow({
        appName,
        dark,
        backgroundColor: dark ? WINDOW_SURFACE.dark : WINDOW_SURFACE.light,
      }),
  });
  try {
    return await runMigrations({
      home: abacusBotHome(),
      userData: app.getPath("userData"),
      appVersion: app.getVersion(),
      steps: MIGRATION_STEPS,
      // A development-only lever: a shipped build never re-runs a step.
      rerun: app.isPackaged ? [] : parseRerunArgs(process.argv),
      onProgress: (done, total, label) => progress?.report(done, total, label),
      log: (message) => console.log(`[migrations] ${message}`),
    });
  } catch (error) {
    console.error("[migrations] runner failed", error);
    return null;
  } finally {
    // Off screen now, before the main window is created.
    progress.finish();
  }
};

/**
 * Frees the progress window once the main window exists (destroying the
 * only window would fire `window-all-closed`, which quits on Windows and
 * Linux).
 */
export const disposeMigrationProgress = (): void => {
  progress?.dispose();
  progress = null;
};
