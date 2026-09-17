/**
 * Merging PATH-like lists, kept on its own because of who needs it.
 *
 * It used to live in `sandbox/shell.ts`, which imports `posix-shell.ts`, which
 * imports pi. `posix-shell-install.ts` is an entry point the desktop's Electron
 * main imports (see tsdown.config.ts), and main may not reach pi: those
 * packages are left external and are not inside the app's asar. Taking one
 * twenty-line helper from `sandbox/shell.ts` pulled the whole agent in behind
 * it — 6.7 MB, pi-tui and yaml included — and the packaged app stopped
 * starting. A module with no imports but `node:path` cannot do that to anyone.
 */
import * as path from "node:path";

export function mergePath(
  front: string | undefined,
  back: string | undefined,
  // ";" on Windows, where splitting on ":" would cut every `C:\` entry in half.
  delimiter: string = path.delimiter
): string | undefined {
  const entries = [
    ...(front ?? "").split(delimiter),
    ...(back ?? "").split(delimiter),
  ].filter((entry) => entry.length > 0);
  const seen = new Set<string>();
  const merged = entries.filter((entry) =>
    seen.has(entry) ? false : seen.add(entry) !== undefined
  );

  return merged.length > 0 ? merged.join(delimiter) : undefined;
}
