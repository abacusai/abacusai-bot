/**
 * The Windows shell's `grep`, `egrep` and `fgrep` take GNU's options.
 *
 * BusyBox's grep fails on --include, --exclude-dir, -P and every long option
 * with a usage message, and `grep -r PATTERN` with no file reads stdin; behind
 * `2>/dev/null` either reads as "no matches". A launcher ahead of the applet
 * hands such a command to grep-shim.ts; any other goes on to the applet, at
 * the cost of one extra `sh` process.
 */
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";

import { bundledToolsDir } from "./bundled-tools.js";
import { GREP_BUSYBOX_ENV, GREP_RG_ENV } from "./grep-shim.js";
import {
  entryBeside,
  execAsNode,
  launcherDir,
  selfNode,
  shellQuote,
  withOverrides,
  writeLauncher,
} from "./launchers.js";
import { mergePath } from "./merge-path.js";
import { BUSYBOX_PAYLOAD, type PosixShell } from "./posix-shell-install.js";

/** The names that get a launcher, and the matcher each implies. */
const GREP_NAMES: Record<string, string> = {
  grep: "",
  egrep: "-E",
  fgrep: "-F",
};

/** Short options BusyBox grep has; any other (-r, -R, a long option) goes to the shim. */
const BUSYBOX_LETTERS = "HhnlLoqvsiwFEIacxmABCef";

/** One launcher: the applet unless an argument needs GNU's grep. */
export function grepLauncherScript(
  name: string,
  node: string,
  entry: string
): string {
  const matcher = GREP_NAMES[name] ?? "";
  const flags = entry.endsWith(".ts") ? ["--no-warnings"] : [];
  const shim = execAsNode(node, [
    ...flags,
    shellQuote(entry),
    "grep",
    ...(matcher === "" ? [] : [matcher]),
  ]);

  return [
    "#!/bin/sh",
    'for arg in "$@"; do',
    '  case "$arg" in',
    "    --) break ;;",
    "    --color|--color=*) ;;",
    `    --?*) ${shim} ;;`,
    "    -?*)",
    '      head=${arg%%[0-9]*}; digits=${arg#"$head"}',
    `      case "$head" in -*[!${BUSYBOX_LETTERS}]*) ${shim} ;; esac`,
    "      # Digits only as the value of a trailing -m, -A, -B or -C (-m1, -A3), as BusyBox takes them.",
    '      if [ -n "$digits" ]; then',
    `        case "$head" in *[mABC]) ;; *) ${shim} ;; esac`,
    `        case "$digits" in *[!0-9]*) ${shim} ;; esac`,
    "      fi ;;",
    "  esac",
    "done",
    `exec "$${GREP_BUSYBOX_ENV}" ${name} "$@"`,
    "",
  ].join("\n");
}

let launchers: string | null | undefined;

/** The launcher directory, written once per runtime and build; null when it cannot be. */
function grepLaunchers(): string | null {
  if (launchers !== undefined) return launchers;
  const entry = entryBeside(import.meta.url, "grep-shim");
  if (entry == null) return (launchers = null);
  const node = selfNode();
  const dir = launcherDir(
    "grep-shim",
    node,
    entry,
    readFileSync(entry, "utf8")
  );
  const target = entry.replaceAll("\\", "/");
  try {
    for (const name of Object.keys(GREP_NAMES))
      writeLauncher(
        path.join(dir, name),
        grepLauncherScript(name, node, target)
      );
  } catch (error) {
    process.stderr.write(`[grep] launchers not written: ${String(error)}\n`);
    return (launchers = null);
  }

  return (launchers = dir);
}

/** Test seam: forget the launchers. */
export function resetGrepLaunchersForTesting(): void {
  launchers = undefined;
}

/** The busybox executable that runs an applet named as its first argument. */
export function busyboxExecutable(shell: PosixShell): string {
  // A direct payload is the executable; an install keeps it beside its launchers.
  return shell.args != null
    ? shell.sh
    : path.join(path.dirname(shell.bin), BUSYBOX_PAYLOAD);
}

/**
 * The bundled shell's environment with the grep launchers first on PATH and
 * the applets giving way to them. Unchanged when they could not be written.
 */
export function grepShimEnv(
  env: Record<string, string>,
  shell: PosixShell
): Record<string, string> {
  const dir = grepLaunchers();
  if (dir == null) return env;
  const rg = path.join(
    bundledToolsDir(),
    process.platform === "win32" ? "rg.exe" : "rg"
  );

  return {
    ...env,
    PATH:
      mergePath(dir, env.PATH, process.platform === "win32" ? ";" : ":") ?? dir,
    BB_OVERRIDE_APPLETS: withOverrides(
      env.BB_OVERRIDE_APPLETS,
      Object.keys(GREP_NAMES)
    ),
    [GREP_BUSYBOX_ENV]: busyboxExecutable(shell).replaceAll("\\", "/"),
    ...(existsSync(rg) ? { [GREP_RG_ENV]: rg.replaceAll("\\", "/") } : {}),
  };
}
