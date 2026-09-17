/**
 * Keep one stray async error from taking the whole app down. Electron's default
 * for an uncaught main-process exception is a modal error box, which blocks the
 * main process: every window's IPC stalls and its spinners never resolve. The
 * connectors, MCP servers and updater raise async failures routinely on a
 * laptop that sleeps and changes networks. Every exception is still logged with
 * its stack; renderer crashes and `render-process-gone` are untouched.
 */

/** Set once installed, so double registration can't stack handlers. */
let installed = false;

export function installCrashGuard(): void {
  if (installed) return;
  installed = true;

  // A parent terminal that has gone away closes stdout/stderr, and a write
  // to a closed pipe is an EPIPE error on the stream — with no listener,
  // an uncaught exception. The handler below logs to the same stream, so
  // one dead pipe became an exception per log line, forever. A listener
  // makes the failed write a no-op; the file log still gets every line.
  for (const stream of [process.stdout, process.stderr]) {
    stream.on("error", () => {});
  }

  process.on("uncaughtException", (error: Error) => {
    console.error(
      "[crash-guard] uncaught exception in the main process:",
      error.stack ?? error.message
    );
  });

  process.on("unhandledRejection", (reason: unknown) => {
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
