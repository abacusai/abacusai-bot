import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { profileBaseDir } from "../../profile-home";

const contains = (parent: string, child: string): boolean => {
  const relative = path.relative(parent, child);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
};

/** Resolve only configured app directories, never a path from an RPC request. */
const targets = (userData: readonly string[] = []): string[] => {
  const base = path.resolve(profileBaseDir());
  const dirs = [
    ...new Set([base, ...userData.map((dir) => path.resolve(dir))]),
  ];
  for (const dir of dirs) {
    let canonical = dir;
    try {
      if (fs.lstatSync(dir).isSymbolicLink())
        throw new Error("Refusing to delete a symbolic app data directory.");
      canonical = fs.realpathSync(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
    const protectedDirs = [
      path.parse(dir).root,
      os.homedir(),
      os.tmpdir(),
      process.cwd(),
    ].map((value) => {
      try {
        return fs.realpathSync(value);
      } catch {
        return path.resolve(value);
      }
    });
    if (protectedDirs.some((protectedDir) => contains(canonical, protectedDir)))
      throw new Error("Refusing to delete an unsafe app data directory.");
  }
  return dirs.filter(
    (dir) => !dirs.some((other) => other !== dir && contains(other, dir))
  );
};

/** The marker contains no paths and survives removal of the profile base. */
export const pendingEraseMarkerPath = (): string =>
  `${path.resolve(profileBaseDir())}.delete-pending`;
export const isDataResetPending = (): boolean =>
  fs.existsSync(pendingEraseMarkerPath());

/** Arm the next launch, while the running app still owns open stores. */
export const requestDataReset = (
  lifecycle: { relaunch(): void; quit(): void },
  userData: readonly string[] = []
): void => {
  targets(userData);
  const marker = pendingEraseMarkerPath();
  if (fs.existsSync(marker)) return;
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, JSON.stringify({ ownerPid: process.pid }), {
    flag: "wx",
    mode: 0o600,
  });
  try {
    lifecycle.relaunch();
  } catch (error) {
    fs.rmSync(marker, { force: true });
    throw error;
  }
  // Let the confirmed RPC reply leave before the normal before-quit cleanup.
  setImmediate(() => lifecycle.quit());
};

/** Run before profile selection, Chromium, or any store opens files. */
export const finishPendingErase = (userData: readonly string[] = []): void => {
  const marker = pendingEraseMarkerPath();
  if (!fs.existsSync(marker)) return;
  const dirs = targets(userData);
  const record = JSON.parse(fs.readFileSync(marker, "utf8")) as {
    ownerPid?: unknown;
  };
  if (!Number.isInteger(record.ownerPid) || Number(record.ownerPid) <= 0)
    throw new Error("The pending data reset marker is invalid.");
  let running = true;
  try {
    process.kill(Number(record.ownerPid), 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") running = false;
  }
  if (running)
    throw new Error(
      "Close the previous AbacusAI Bot instance before finishing the data reset."
    );
  // Windows may retain handles briefly after exit. Never boot a half-erased
  // profile: retain the marker and fail startup if the bounded retries fail.
  for (const dir of dirs)
    fs.rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 150,
    });
  fs.rmSync(marker);
};
