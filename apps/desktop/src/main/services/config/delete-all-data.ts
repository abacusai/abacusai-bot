import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import { profileBaseDir } from "../../profile-home";

/**
 * "Delete all my data": erases `~/.abacusai-bot/`, never the per-project
 * folders inside the user's own repositories. On Windows it spans two runs:
 * Chromium holds its stores open for the life of the process, so a marker is
 * written first and the next launch finishes whatever stayed locked.
 */

/** Guard against a config that would point the delete at something else. */
const isSafeToDelete = (dir: string): boolean => {
  const resolved = path.resolve(dir);

  return path.dirname(resolved) !== resolved && path.basename(resolved) !== "";
};

/**
 * Next to the base directory, not inside it, or it would go with the erase it
 * records. A bare flag: its content cannot redirect the erase.
 */
export const pendingEraseMarkerPath = (): string =>
  `${path.resolve(profileBaseDir())}.delete-pending`;

/**
 * Remove the profile base, not only the active profile: `ABACUSAI_BOT_HOME`
 * points at one child while other accounts remain in the base. Locked files
 * are not an error; the marker hands them to the next launch. Returns the
 * resolved path so the caller can log what went.
 */
export const eraseUserData = async (
  legacyDirectories: readonly string[] = []
): Promise<string> => {
  const dir = path.resolve(profileBaseDir());

  if (!isSafeToDelete(dir)) {
    throw new Error(`Refusing to delete an unexpected data directory: ${dir}`);
  }

  const legacyDirs = [
    ...new Set(legacyDirectories.map((candidate) => path.resolve(candidate))),
  ].filter((legacyDir) => legacyDir !== dir);
  // Validate the whole set first: a bad legacy path must not turn a rejected
  // request into a partial deletion.
  for (const legacyDir of legacyDirs) {
    if (!isSafeToDelete(legacyDir)) {
      throw new Error(
        `Refusing to delete an unexpected legacy data directory: ${legacyDir}`
      );
    }
  }

  const marker = pendingEraseMarkerPath();
  await fs.mkdir(path.dirname(marker), { recursive: true });
  await fs.writeFile(marker, "");

  const targets = [dir, ...legacyDirs];
  for (const target of targets) {
    await fs.rm(target, { recursive: true, force: true }).catch(() => {});
  }
  if (!targets.some((target) => fsSync.existsSync(target))) {
    await fs.rm(marker, { force: true });
  }

  return dir;
};

/**
 * Finish an erase the previous run could not complete. Runs at launch before
 * anything opens a file under the profile. Anything still locked keeps the
 * marker for the launch after; startup never fails over this.
 */
export const finishPendingErase = (
  legacyDirectories: readonly string[] = []
): void => {
  const marker = pendingEraseMarkerPath();
  if (!fsSync.existsSync(marker)) return;

  const dir = path.resolve(profileBaseDir());
  const targets = new Set([
    dir,
    ...legacyDirectories.map((candidate) => path.resolve(candidate)),
  ]);

  let clean = true;
  for (const target of targets) {
    if (!isSafeToDelete(target)) {
      clean = false;
      continue;
    }
    try {
      fsSync.rmSync(target, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 150,
      });
    } catch {
      clean = false;
    }
  }

  if (clean) fsSync.rmSync(marker, { force: true });
  console.log(
    clean
      ? `[delete-all-data] finished erasing ${dir}`
      : `[delete-all-data] ${dir} still has locked leftovers; retrying next launch`
  );
};
