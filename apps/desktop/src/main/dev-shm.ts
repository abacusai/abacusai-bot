import fs from "node:fs";

/**
 * Below this, Chromium's shared memory runs out mid-render: one 1080×1920
 * frame is 8 MB, and Docker's default /dev/shm is 64 MB. The GPU process then
 * dies ("CopyOutputResultSender … DESERIALIZATION_FAILED") and a motion
 * render, or any other big capture, fails partway.
 */
export const DEV_SHM_MIN_BYTES = 512 * 1024 * 1024;

/**
 * Whether Chromium should keep its shared memory in /tmp instead of /dev/shm.
 * Linux only; a missing /dev/shm counts as too small.
 */
export const devShmTooSmall = (
  platform: NodeJS.Platform = process.platform,
  statfs: (path: string) => { bsize: number; blocks: number } = fs.statfsSync
): boolean => {
  if (platform !== "linux") return false;
  try {
    const stats = statfs("/dev/shm");
    return stats.bsize * stats.blocks < DEV_SHM_MIN_BYTES;
  } catch {
    return true;
  }
};
