/**
 * Backups and file moves for the migration commit protocol (spec 00 C.1).
 *
 * A step's backups live in `<home>/backups/migrations/<stamp>-<id>-<name>/`,
 * mirroring each file's path under the home (`home/…`), else under userData
 * (`userData/…`), else its absolute path (`abs/…`). Quarantined sources
 * (C.5) live in `<home>/backups/quarantine/`.
 */
import fs from "node:fs";
import path from "node:path";

export const MIGRATING_DIR_NAME = ".migrating";

export const migratingRoot = (home: string): string =>
  path.join(home, MIGRATING_DIR_NAME);

export const backupsRoot = (home: string): string =>
  path.join(home, "backups", "migrations");

export const quarantineRoot = (home: string): string =>
  path.join(home, "backups", "quarantine");

/** `20260930T121314123Z`: sortable, and safe in a file name everywhere. */
export const formatStamp = (date: Date): string =>
  date.toISOString().replace(/[-:.]/g, "");

export const parseStamp = (stamp: string): Date | null => {
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(\d{3})Z$/.exec(
    stamp
  );
  if (match == null) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  const date = new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
  return Number.isNaN(date.getTime()) ? null : date;
};

const inside = (root: string, file: string): string | null => {
  const relative = path.relative(root, file);
  return relative !== "" &&
    !relative.startsWith("..") &&
    !path.isAbsolute(relative)
    ? relative
    : null;
};

export const backupPathFor = (
  backupDir: string,
  file: string,
  roots: { home: string; userData: string }
): string => {
  const underHome = inside(roots.home, file);
  if (underHome != null) return path.join(backupDir, "home", underHome);
  const underUserData = inside(roots.userData, file);
  if (underUserData != null)
    return path.join(backupDir, "userData", underUserData);
  const { root } = path.parse(file);
  return path.join(
    backupDir,
    "abs",
    root.replace(/[:\\/]/g, ""),
    file.slice(root.length)
  );
};

export const exists = (file: string): boolean => {
  try {
    fs.lstatSync(file);
    return true;
  } catch {
    return false;
  }
};

/** Copy through a temp name and rename, so `dest` is never half written. */
export const copyFileAtomic = (source: string, dest: string): void => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const temporary = `${dest}.${process.pid}.migrating-tmp`;
  fs.copyFileSync(source, temporary);
  fs.renameSync(temporary, dest);
};

/**
 * `rename`, atomic within a volume (staging sits under the home for exactly
 * that reason). Across volumes (a userData elsewhere) it copies atomically
 * and then removes the source.
 */
export const moveFile = (source: string, dest: string): void => {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  try {
    fs.renameSync(source, dest);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EXDEV") throw error;
    copyFileAtomic(source, dest);
    fs.rmSync(source, { force: true });
  }
};

const DAY_MS = 24 * 60 * 60 * 1000;

export interface PruneOptions {
  now: Date;
  /** Backups older than this go (30 days). */
  maxAgeDays?: number;
  /** Per step, only the newest this many stay (3). */
  keepPerStep?: number;
  /** Quarantined files older than this go (90 days). */
  quarantineDays?: number;
}

/** Returns what was removed, for the log. */
export const pruneBackups = (home: string, options: PruneOptions): string[] => {
  const removed: string[] = [];
  const now = options.now.getTime();
  const maxAge = (options.maxAgeDays ?? 30) * DAY_MS;
  const keep = options.keepPerStep ?? 3;

  const root = backupsRoot(home);
  let names: string[] = [];
  try {
    names = fs.readdirSync(root);
  } catch {
    names = [];
  }
  const byStep = new Map<string, { name: string; at: number }[]>();
  for (const name of names) {
    const match = /^(\d{8}T\d{9}Z)-(\d+-.+)$/.exec(name);
    const at = match == null ? null : parseStamp(match[1]);
    if (match == null || at == null) continue;
    const list = byStep.get(match[2]) ?? [];
    list.push({ name, at: at.getTime() });
    byStep.set(match[2], list);
  }
  for (const list of byStep.values()) {
    list.sort((a, b) => b.at - a.at);
    list.forEach((entry, index) => {
      if (index < keep && now - entry.at <= maxAge) return;
      const target = path.join(root, entry.name);
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    });
  }

  const quarantineAge = (options.quarantineDays ?? 90) * DAY_MS;
  const quarantine = quarantineRoot(home);
  let kinds: string[] = [];
  try {
    kinds = fs.readdirSync(quarantine);
  } catch {
    kinds = [];
  }
  for (const kind of kinds) {
    const directory = path.join(quarantine, kind);
    let entries: string[] = [];
    try {
      entries = fs.readdirSync(directory);
    } catch {
      continue;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry);
      try {
        if (now - fs.statSync(target).mtimeMs <= quarantineAge) continue;
      } catch {
        continue;
      }
      fs.rmSync(target, { recursive: true, force: true });
      removed.push(target);
    }
  }
  return removed;
};
