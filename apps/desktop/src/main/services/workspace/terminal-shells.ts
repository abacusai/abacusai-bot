/**
 * Turning a `TerminalShellId` into something spawnable, and saying which ids
 * this machine can actually answer for.
 *
 * busybox is the reason this file exists: it is not on PATH and not installed
 * by anything the user did — it ships in the app's vendor directory and is
 * materialised per user by the agent package, which hands back the `sh`
 * launcher plus the applet directory its children need on PATH.
 */
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  installPosixShell,
  posixShellEnv,
  type PosixShell,
} from "@abacus-ai/agent/posix-shell-install";

import { agentVendorDir } from "#main/resources";
import {
  DEFAULT_TERMINAL_SHELL,
  TERMINAL_SHELLS,
  terminalShellsForPlatform,
  type TerminalShellId,
  type TerminalShellStatus,
} from "#shared/terminal-shells";

export interface ResolvedTerminalShell {
  /** What was resolved, which is `system` when the request could not be. */
  id: TerminalShellId;
  file: string;
  args: string[];
  /** Merged over the inherited environment; busybox needs its applets on PATH. */
  env?: Record<string, string>;
}

const isFile = (candidate: string): boolean => {
  try {
    return statSync(candidate).isFile();
  } catch {
    // Missing, or a path whose parent is not a directory.
    return false;
  }
};

/**
 * First match on PATH, honouring PATHEXT on Windows so `pwsh` finds
 * `pwsh.exe`. `where`/`which` would do the same by spawning a process per
 * lookup, and this runs once per settings render.
 *
 * Each extension is tried as PATHEXT spells it and again in lower case:
 * PATHEXT is `.COM;.EXE;...` by convention while the files on disk are
 * `pwsh.exe`, and Windows only gets away with that because its filesystems
 * are case-insensitive. On one that is not — a mounted share, or a Linux box
 * running these tests — the uppercase form alone finds nothing.
 */
const onPath = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined => {
  const entries = (env.PATH ?? env.Path ?? "").split(path.delimiter);
  const extensions =
    platform === "win32"
      ? [
          "",
          ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD")
            .split(";")
            .filter((extension) => extension.length > 0)
            .flatMap((extension) => {
              const lowered = extension.toLowerCase();

              return lowered === extension ? [extension] : [extension, lowered];
            }),
        ]
      : [""];

  for (const entry of entries) {
    if (entry.length === 0) continue;
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (isFile(candidate)) return candidate;
    }
  }

  return undefined;
};

/** The shipped busybox payload, or undefined in a build without one. */
export const busyboxPayload = (): string | undefined => {
  const payload = path.join(agentVendorDir(), "busybox.exe");

  return existsSync(payload) ? payload : undefined;
};

let installedBusybox: PosixShell | undefined | null = null;

/**
 * The materialised busybox, installed once per process. Verifying an install
 * digests the executable and stats every launcher, and a terminal start
 * resolves the shell twice — once for the snapshot, once to spawn.
 */
const busybox = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): PosixShell | undefined => {
  if (installedBusybox !== null) return installedBusybox;
  const payload = busyboxPayload();
  installedBusybox =
    payload == null ? undefined : installPosixShell({ payload, platform, env });

  return installedBusybox;
};

/** Test seam: forget the memoised install. */
export const resetBusyboxForTesting = (): void => {
  installedBusybox = null;
};

/**
 * Windows PowerShell lives at a fixed path under the system root. Looked up
 * there first because PATH can be missing it in a stripped environment, and
 * the built-in is what the menu entry promises.
 */
const windowsPowerShell = (env: NodeJS.ProcessEnv): string | undefined => {
  const root = env.SystemRoot ?? env.windir;
  if (root != null) {
    const shipped = path.join(
      root,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe"
    );
    if (isFile(shipped)) return shipped;
  }

  return onPath("powershell", env, "win32");
};

const systemShell = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ResolvedTerminalShell =>
  platform === "win32"
    ? { id: "system", file: env.ComSpec ?? "cmd.exe", args: [] }
    : { id: "system", file: env.SHELL ?? "/bin/bash", args: ["-l"] };

export interface ResolveTerminalShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
}

/**
 * Where a shell id points on this machine, or null when it points nowhere.
 * Callers that must spawn something use `resolveTerminalShell`, which falls
 * back; this one answers the roster.
 */
const locate = (
  id: TerminalShellId,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ResolvedTerminalShell | null => {
  switch (id) {
    case "system":
      return systemShell(env, platform);

    case "cmd": {
      const file = env.ComSpec ?? onPath("cmd", env, platform);

      return file != null && isFile(file) ? { id, file, args: [] } : null;
    }

    case "powershell": {
      const file = windowsPowerShell(env);

      // -NoLogo: the copyright banner is noise in a panel this small.
      return file == null ? null : { id, file, args: ["-NoLogo"] };
    }

    case "pwsh": {
      const file = onPath("pwsh", env, platform);

      return file == null ? null : { id, file, args: ["-NoLogo"] };
    }

    case "busybox": {
      const shell = busybox(env, platform);
      if (shell == null) return null;

      const shellEnv = Object.fromEntries(
        Object.entries(posixShellEnv(env, shell)).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string"
        )
      );

      return {
        id,
        file: shell.sh,
        // -i, because ash decides it is interactive by asking whether its
        // input is a terminal, and on Windows this app spawns through a pipe
        // rather than ConPTY (see terminal-session-service.ts). Without it
        // ash reads the pipe as a script: commands run, and nothing else
        // happens — no prompt, no line editing, no job control.
        args: ["-i"],
        env: {
          ...shellEnv,
          // ash prints no prompt without one, and reads none from a profile
          // it was never told to load. `\w` is the working directory.
          PS1: env.PS1 ?? "\\w $ ",
          // The PTY is an xterm; ash asks $TERM before it edits a line.
          TERM: env.TERM ?? "xterm-256color",
          // So `cd` with no argument and `~` go somewhere.
          ...(env.HOME == null && env.USERPROFILE != null
            ? { HOME: env.USERPROFILE }
            : {}),
        },
      };
    }
  }
};

/**
 * What to spawn for a stored or requested id. Never null: an id that no longer
 * resolves falls back to the platform default rather than leaving the panel
 * with nothing to open, and the returned `id` says which shell it really is.
 */
export const resolveTerminalShell = (
  id: TerminalShellId = DEFAULT_TERMINAL_SHELL,
  options: ResolveTerminalShellOptions = {}
): ResolvedTerminalShell => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const offered = terminalShellsForPlatform(platform).some(
    (shell) => shell.id === id
  );

  try {
    const located = offered ? locate(id, env, platform) : null;
    if (located != null) return located;
  } catch {
    // A busybox install that could not verify, a PATH entry that threw:
    // neither is a reason to leave the user without a terminal.
  }

  return systemShell(env, platform);
};

/** The roster for the settings pane and the `+` menu, with live availability. */
export const terminalShellStatuses = (
  options: ResolveTerminalShellOptions = {}
): TerminalShellStatus[] => {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;

  return terminalShellsForPlatform(platform).map(({ id }) => {
    if (id === "busybox") {
      // Availability is the shipped payload, not an install: materialising
      // ~100 launchers to render a settings row would be absurd, and the
      // spawn does it anyway.
      return { id, available: busyboxPayload() != null };
    }

    let located: ResolvedTerminalShell | null = null;
    try {
      located = locate(id, env, platform);
    } catch {
      located = null;
    }

    return located == null
      ? { id, available: false }
      : { id, available: true, path: located.file };
  });
};

/** What a new terminal actually gets, given what is stored. */
export const effectiveTerminalShell = (
  selected: TerminalShellId,
  options: ResolveTerminalShellOptions = {}
): TerminalShellId => resolveTerminalShell(selected, options).id;

/** Every id, for callers validating a stored value. */
export const TERMINAL_SHELL_IDS: readonly TerminalShellId[] =
  TERMINAL_SHELLS.map((shell) => shell.id);
