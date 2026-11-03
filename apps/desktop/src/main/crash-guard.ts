/**
 * Keep one stray async error from taking the whole app down. Electron's default
 * for an uncaught main-process exception is a modal error box, which blocks the
 * main process: every window's IPC stalls and its spinners never resolve. The
 * connectors, MCP servers and updater raise async failures routinely on a
 * laptop that sleeps and changes networks. Every exception is still logged with
 * its stack (a full disk's repeats are counted, not each logged); renderer
 * crashes and `render-process-gone` are untouched.
 */

import { isDiskFull } from "@abacus-ai/agent/atomic-file";

/** Set once installed, so double registration can't stack handlers. */
let installed = false;

/**
 * A full disk fails every write the app makes, some of them every second:
 * the first is logged with its stack, the rest are counted and summed up at
 * most this often until space is back.
 */
const DISK_FULL_LOG_EVERY_MS = 10 * 60_000;
let diskFullLoggedAt: number | null = null;
let diskFullFolded = 0;

/** Whether this error is logged now; a full disk's repeats are folded. */
const logNow = (error: unknown): boolean => {
  if (!isDiskFull(error)) return true;
  const now = Date.now();
  if (
    diskFullLoggedAt != null &&
    now - diskFullLoggedAt < DISK_FULL_LOG_EVERY_MS
  ) {
    diskFullFolded += 1;
    return false;
  }
  if (diskFullFolded > 0)
    console.error(
      `[crash-guard] the disk is still full: ${diskFullFolded} more write failures since the last one logged`
    );
  diskFullLoggedAt = now;
  diskFullFolded = 0;
  return true;
};

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  // A parent terminal that has gone away closes stdout/stderr, and a write
  // to a closed pipe is an EPIPE error on the stream, which with no
  // listener becomes an uncaught exception. The handler below logs to the same stream, so
  // one dead pipe became an exception per log line, forever. A listener
  // makes the failed write a no-op; the file log still gets every line.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {});
  }

  process.on("uncaughtException", (error: Error) => {
    if (!logNow(error)) return;
    console.error(
      "[crash-guard] uncaught exception in the main process:",
      error.stack ?? error.message
    );
  });

  process.on("unhandledRejection", (reason: unknown) => {
    if (!logNow(reason)) return;
    const detail =
      reason instanceof Error
        ? (reason.stack ?? reason.message)
        : String(reason);
    console.error(
      "[crash-guard] unhandled promise rejection in the main process:",
      detail
    );
  });
}
