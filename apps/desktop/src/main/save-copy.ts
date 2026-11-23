/**
 * "Save" and "Save all" on the files the bot made: a copy goes where the
 * user picks, and nothing there is replaced without the user saying so.
 *
 * One file opens the OS save dialog, which asks before replacing a file.
 * Several items, or a folder, open a folder picker; each is copied in under
 * a name nothing there uses yet ("report (2).pdf"). A folder (a site the
 * bot built) is copied as a folder, so it opens as it did: a zip would need
 * unpacking first. Its `node_modules` and `.git` stay behind.
 */
import type { Stats } from "fs";
import fs from "fs/promises";
import os from "os";
import path from "path";

import type {
  SaveCopyItem,
  SaveCopyResult,
} from "@abacus-ai/contract/contract/system";

import {
  locateHostFile,
  resolveHostPath,
} from "./services/workspace/host-path";

export interface SaveCopyDialogs {
  /** The save dialog, opened on `defaultPath`; null when cancelled. */
  saveFile(defaultPath: string): Promise<string | null>;
  /** A folder picker, opened on `defaultPath`; null when cancelled. */
  pickFolder(defaultPath: string): Promise<string | null>;
  /** Where the dialogs open (the Downloads folder). */
  defaultDir: string;
  home?: string;
}

interface Source {
  real: string;
  stat: Stats;
}

/** Rebuildable or private: never part of what the user asked for. */
const SKIPPED_IN_FOLDERS = new Set(["node_modules", ".git"]);

const isTaken = (error: unknown): boolean =>
  (error as NodeJS.ErrnoException | null)?.code === "EEXIST";

/** The file or folder an item names, or null when it is not there. */
const sourceOf = async (
  item: SaveCopyItem,
  home: string | undefined
): Promise<Source | null> => {
  const located = await locateHostFile(
    resolveHostPath(item.filePath, item.hostRoot, home)
  );
  if (located == null) return null;
  try {
    const real = await fs.realpath(located);
    const stat = await fs.stat(real);
    return stat.isFile() || stat.isDirectory() ? { real, stat } : null;
  } catch {
    return null;
  }
};

/** `name`, then "name (2)", "name (3)"…; the extension stays last. */
const candidateName = (name: string, n: number, folder: boolean): string => {
  if (n === 1) return name;
  const ext = folder ? "" : path.extname(name);
  return `${name.slice(0, name.length - ext.length)} (${n})${ext}`;
};

const copyFolder = (from: string, to: string): Promise<void> =>
  fs.cp(from, to, {
    recursive: true,
    // `to` is new and empty; nothing in it is replaced.
    force: false,
    // A link stays a link, as it was; its target is not copied in.
    verbatimSymlinks: true,
    filter: (entry) => !SKIPPED_IN_FOLDERS.has(path.basename(entry)),
  });

/**
 * Takes the first name not used in `dir` with an exclusive create, so
 * something that appears meanwhile is never replaced.
 */
const claimName = async (
  dir: string,
  name: string,
  folder: boolean
): Promise<string> => {
  for (let n = 1; ; n++) {
    const target = path.join(dir, candidateName(name, n, folder));
    try {
      if (folder) await fs.mkdir(target);
      else await (await fs.open(target, "wx")).close();
      return target;
    } catch (error) {
      if (!isTaken(error) || n >= 1000) throw error;
    }
  }
};

/** Copies `source` into `dir` under a name of its own there. */
const copyInto = async (source: Source, dir: string): Promise<string> => {
  const folder = source.stat.isDirectory();
  const target = await claimName(dir, path.basename(source.real), folder);
  try {
    if (folder) await copyFolder(source.real, target);
    else await fs.copyFile(source.real, target);
  } catch (error) {
    // A half copy is not left behind as if it were saved.
    await fs.rm(target, { recursive: true, force: true });
    throw error;
  }
  return target;
};

/** Whether `inner` is `outer` or inside it. */
const isWithin = (outer: string, inner: string): boolean => {
  const rel = path.relative(outer, inner);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
};

export async function saveCopies(
  items: readonly SaveCopyItem[],
  dialogs: SaveCopyDialogs
): Promise<SaveCopyResult> {
  const sources: Source[] = [];
  for (const item of items) {
    const source = await sourceOf(item, dialogs.home ?? os.homedir());
    // The same file named twice is saved once.
    if (source != null && !sources.some((s) => s.real === source.real))
      sources.push(source);
  }
  const missing = items.length - sources.length;
  const only = sources.length === 1 ? sources[0]! : null;
  if (sources.length === 0)
    return { destination: null, saved: 0, skipped: missing };

  if (only != null && only.stat.isFile()) {
    const picked = await dialogs.saveFile(
      path.join(dialogs.defaultDir, path.basename(only.real))
    );
    if (picked == null) return { destination: null, saved: 0, skipped: 0 };
    // The dialog asked before replacing; saving a file onto itself is done.
    const existing = await fs.realpath(picked).catch(() => null);
    if (existing !== only.real) await fs.copyFile(only.real, picked);
    return { destination: picked, saved: 1, skipped: missing };
  }

  const dir = await dialogs.pickFolder(dialogs.defaultDir);
  if (dir == null) return { destination: null, saved: 0, skipped: 0 };
  const realDir = await fs.realpath(dir);
  let saved = 0;
  let failed = 0;
  let lastError: unknown;
  for (const source of sources) {
    // A folder copied into itself would never end.
    if (source.stat.isDirectory() && isWithin(source.real, realDir)) {
      failed += 1;
      continue;
    }
    try {
      await copyInto(source, realDir);
      saved += 1;
    } catch (error) {
      failed += 1;
      lastError = error;
    }
  }
  // Nothing went in because the copies failed: the caller says so.
  if (saved === 0 && lastError != null) throw lastError;
  return { destination: realDir, saved, skipped: missing + failed };
}
