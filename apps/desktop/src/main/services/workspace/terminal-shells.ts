/**
 * Turning a `TerminalShellId` into something spawnable, and saying which ids
 * this machine can actually answer for.
 *
 * busybox is the reason this file exists: it is not on PATH and not installed
 * by anything the user did. It ships in the app's vendor directory and is
 * materialised per user by the agent package, which hands back the `sh`
 * launcher plus the applet directory its children need on PATH.
 */
import { execFile } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import path from "node:path";

import {
  BUSYBOX_PAYLOAD,
  posixShellEnv,
  resolvePosixShell,
  type PosixShell,
} from "@abacus-ai/agent/posix-shell-install";
import {
  DEFAULT_TERMINAL_SHELL,
  terminalShellsForPlatform,
  type TerminalShellId,
  type TerminalShellStatus,
} from "@abacus-ai/contract/terminal-shells";

import { agentVendorDir } from "#main/resources";

import { readTerminalShell } from "../config/settings";

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
 * are case-insensitive. On one that is not (a mounted share, or a Linux box
 * running these tests), the uppercase form alone finds nothing.
 */
const onPath = (
  command: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): string | undefined => {
  const entries = (env.PATH ?? "").split(path.delimiter);
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
  const payload = path.join(agentVendorDir(), BUSYBOX_PAYLOAD);

  return existsSync(payload) ? payload : undefined;
};

let installedBusybox: PosixShell | undefined | null = null;
let busyboxRetryAt = 0;

/**
 * The materialised busybox, installed once per process. Verifying an install
 * digests the executable and stats every launcher, and a terminal start
 * resolves the shell twice: once for the snapshot, once to spawn. A launcher
 * removed since (antivirus software can quarantine busybox) is
 * installed again, as the agent's `bash` does.
 */
const busybox = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): PosixShell | undefined => {
  const vanished = installedBusybox != null && !existsSync(installedBusybox.sh);
  if (
    installedBusybox !== null &&
    !vanished &&
    ((installedBusybox !== undefined && installedBusybox.args == null) ||
      Date.now() < busyboxRetryAt)
  )
    return installedBusybox;
  const payload = busyboxPayload();
  // Resolved, not just installed: the build that runs here, the same one the
  // agent's `bash` tool picked.
  installedBusybox =
    payload == null ? undefined : resolvePosixShell({ payload, platform, env });
  busyboxRetryAt = Date.now() + 30_000;

  return installedBusybox;
};

/** Test seam: forget the memoised install. */
export const resetBusyboxForTesting = (): void => {
  installedBusybox = null;
  busyboxRetryAt = 0;
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

/**
 * Git for Windows' bash: the usual install folders, then beside the `git` on
 * PATH (Git\cmd\git.exe → Git\bin\bash.exe). Never `bash` on PATH, which
 * on Windows is often System32's bash.exe, the WSL launcher.
 */
const gitBash = (env: NodeJS.ProcessEnv): string | undefined => {
  const git = onPath("git", env, "win32");
  const roots = [
    env.ProgramW6432,
    env.ProgramFiles,
    env["ProgramFiles(x86)"],
    env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, "Programs"),
  ].filter((root): root is string => !!root);
  const candidates = [
    ...roots.map((root) => path.join(root, "Git", "bin", "bash.exe")),
    ...(git ? [path.join(path.dirname(git), "..", "bin", "bash.exe")] : []),
  ];
  return candidates.find(isFile);
};

let wslDistros: { found: boolean; at: number } | null = null;
let wslQuery: Promise<boolean> | null = null;

/**
 * Whether WSL has a Linux installed. wsl.exe ships with Windows whether or
 * not one is, so its presence says nothing: the installed distributions are
 * the subkeys of HKCU\...\Lxss. Asked of reg.exe off the main thread, one
 * query at a time, and at most every 30 s.
 */
const queryWslInstalled = (): Promise<boolean> => {
  if (wslDistros != null && Date.now() - wslDistros.at < 30_000)
    return Promise.resolve(wslDistros.found);
  wslQuery ??= new Promise<boolean>((resolve) => {
    execFile(
      "reg",
      ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss"],
      { encoding: "utf8", timeout: 3000, windowsHide: true },
      // An error is no key: WSL was never set up.
      (error, out) => resolve(error == null && /\\Lxss\\\{/i.test(out))
    );
  }).then((found) => {
    wslDistros = { found, at: Date.now() };
    wslQuery = null;
    return found;
  });
  return wslQuery;
};

/** The last answer, without asking: no WSL until one came. */
const wslInstalled = (): boolean => wslDistros?.found ?? false;

/**
 * Before a shell id is resolved: what the roster needs to know about this
 * machine that takes a process to learn (WSL's distributions, on Windows).
 */
export const learnTerminalShell = async (
  id: TerminalShellId,
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  if (platform === "win32" && id === "wsl") await queryWslInstalled();
};

/** Before the whole roster is listed (the `+` menu, Settings). */
export const learnTerminalShells = async (
  platform: NodeJS.Platform = process.platform
): Promise<void> => {
  if (platform === "win32") await queryWslInstalled();
};

/** Test seam: forget what was learned about WSL. */
export const resetWslForTesting = (): void => {
  wslDistros = null;
  wslQuery = null;
};

const systemShell = (
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform
): ResolvedTerminalShell =>
  platform === "win32"
    ? { id: "system", file: env.ComSpec ?? "cmd.exe", args: [] }
    : {
        id: "system",
        // A $SHELL that names nothing (uninstalled, mistyped) would die at
        // once with execvp(3) failed: fall back as a login does.
        file:
          [env.SHELL, "/bin/bash", "/bin/sh"].find(
            (file): file is string => file != null && isFile(file)
          ) ??
          env.SHELL ??
          "/bin/bash",
        args: ["-l"],
      };

/**
 * The shell a Windows user who never picked one gets: PowerShell 7 (pwsh)
 * when it is on PATH, else the Windows PowerShell that ships with Windows
 * (which falls back to the system shell if even that is missing).
 */
export const defaultWindowsShell = (
  env: NodeJS.ProcessEnv = process.env
): TerminalShellId =>
  onPath("pwsh", env, "win32") != null ? "pwsh" : "powershell";

/** The stored pick, or this machine's default when there is none. */
export const preferredTerminalShell = (
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env
): TerminalShellId =>
  readTerminalShell(platform, () => defaultWindowsShell(env));

export interface ResolveTerminalShellOptions {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Test seam: whether WSL has a distribution (the registry, by default). */
  wslInstalled?: () => boolean;
}

/**
 * Where a shell id points on this machine, or null when it points nowhere.
 * Callers that must spawn something use `resolveTerminalShell`, which falls
 * back; this one answers the roster.
 */
const locate = (
  id: TerminalShellId,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  hasWsl: () => boolean = wslInstalled
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

    case "wsl": {
      const root = env.SystemRoot ?? env.windir;
      const file = root && path.join(root, "System32", "wsl.exe");
      // The default distribution, starting in the panel's folder (/mnt/c/...).
      return file && isFile(file) && hasWsl() ? { id, file, args: [] } : null;
    }

    case "gitbash": {
      const file = gitBash(env);

      return file == null ? null : { id, file, args: ["--login", "-i"] };
    }

    case "busybox": {
      const shell = busybox(env, platform);
      if (shell == null) return null;

      const shellEnv = posixShellEnv(env, shell);

      return {
        id,
        file: shell.sh,
        // -i, because ash decides it is interactive by asking whether its
        // input is a terminal, and on Windows this app spawns through a pipe
        // rather than ConPTY (see terminal-session-service.ts). Without it
        // ash reads the pipe as a script: commands run, and nothing else
        // happens: no prompt, no line editing, no job control.
        args: [...(shell.args ?? []), "-i"],
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
    const located = offered
      ? locate(id, env, platform, options.wslInstalled)
      : null;
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
      located = locate(id, env, platform, options.wslInstalled);
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
