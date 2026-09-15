/**
 * How a command reaches a shell, and what environment it gets.
 *
 * A GUI-launched app inherits launchd's minimal PATH, so the user's profile is
 * sourced once here, outside the sandbox, and commands run in a non-login shell
 * carrying that environment. A login shell per command would re-run the
 * profile's setup writes (fnm, pyenv, gcloud) under $HOME, which the sandbox
 * refuses; the resulting stderr noise reads as command failure. Shell functions
 * (`nvm`) are lost; ABACUSAI_BOT_LOGIN_SHELL=1 restores a login shell per
 * command.
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as path from "node:path";

import { posixShell } from "../posix-shell.js";

/**
 * The interpreter every confined command runs under. Shared so the sandbox
 * probe exercises the same binary; probing a different shell can pass on a host
 * where this one then dies with exec-127.
 */
export const POSIX_SHELL = "/bin/bash";

/** True when the user has asked for a login shell on every command. */
function loginShellRequested(): boolean {
  return process.env.ABACUSAI_BOT_LOGIN_SHELL === "1";
}

/** The arguments that hand `command` to `/bin/bash`. */
export function shellArgs(command: string): string[] {
  return [loginShellRequested() ? "-lc" : "-c", command];
}

/**
 * What to spawn when a command runs through the platform's own shell (the
 * unconfined paths). A stock Windows install has no bash, and an ENOENT spawn
 * reads as the command failing with no output; cmd.exe's `/d /s /c` is the
 * equivalent (`/d` skips AutoRun, `/s` keeps quote handling predictable).
 */
export function fallbackShell(
  command: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  /** The bundled POSIX shell on Windows, where it is installed (posix-shell.ts). */
  bundled: { sh: string } | undefined = platform === "win32"
    ? posixShell()
    : undefined
): { file: string; args: string[]; windowsVerbatimArguments?: boolean } {
  if (platform === "win32") {
    // The model writes for the POSIX shell it was told it has; cmd.exe is
    // only for a machine with no bundled shell payload.
    if (bundled != null) return { file: bundled.sh, args: ["-c", command] };

    return {
      file: env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", command],
      // Node quotes `args` by C-runtime rules (`"` becomes `\"`), which cmd.exe
      // does not undo. The command text is already written for cmd and must
      // arrive exactly as written.
      windowsVerbatimArguments: true,
    };
  }

  return { file: POSIX_SHELL, args: shellArgs(command) };
}

/**
 * How long the pipes may stay quiet after exit before the command counts as
 * done. Output still arriving re-arms it, so this bounds idleness, not output.
 */
const EXIT_STDIO_GRACE_MS = 100;

/**
 * Settle when the command has finished, rather than when its last fd closes.
 *
 * `close` waits for every inherited stdio handle, and a backgrounded descendant
 * (`cd app && nohup node server.js >> log &`) holds the tool's pipes from a
 * subshell that outlives the shell, so the call never returns and there is no
 * shell left for a deadline to kill. Settling on `exit` once the pipes fall
 * quiet lets a descendant that is still writing re-arm the timer, while one
 * that merely holds the handle stops holding the turn. Same as pi's own shell.
 */
export function settleOnExit(
  child: ChildProcess,
  onSettled: (exitCode: number | null) => void
): void {
  let settled = false;
  let exited = false;
  let exitCode: number | null = null;
  let graceTimer: NodeJS.Timeout | undefined;
  let stdoutEnded = child.stdout == null;
  let stderrEnded = child.stderr == null;

  const settle = (): void => {
    if (settled) return;
    settled = true;
    if (graceTimer != null) clearTimeout(graceTimer);
    child.stdout?.destroy();
    child.stderr?.destroy();
    onSettled(exitCode);
  };

  const armGrace = (): void => {
    if (!exited || settled) return;
    if (graceTimer != null) clearTimeout(graceTimer);
    graceTimer = setTimeout(settle, EXIT_STDIO_GRACE_MS);
    graceTimer.unref?.();
  };

  const settleIfDrained = (): void => {
    if (exited && stdoutEnded && stderrEnded) settle();
  };

  child.stdout?.on("data", armGrace);
  child.stderr?.on("data", armGrace);
  child.stdout?.on("end", () => {
    stdoutEnded = true;
    settleIfDrained();
  });
  child.stderr?.on("end", () => {
    stderrEnded = true;
    settleIfDrained();
  });
  child.on("exit", (code) => {
    exited = true;
    exitCode = code;
    if (stdoutEnded && stderrEnded) settle();
    else armGrace();
  });
  // Still the cleanest finish when nothing outlives the command.
  child.on("close", (code) => {
    exitCode = code ?? exitCode;
    settle();
  });
}

/** What a fallback-shell run produced. Mirrors pi's own exec result shape. */
export interface FallbackResult {
  stdout: string;
  stderr: string;
  code: number;
  killed: boolean;
}

/**
 * Run a command through `fallbackShell` and collect its output. Not `pi.exec`:
 * that cannot ask for `windowsVerbatimArguments`, so the command text would be
 * re-quoted on the way to cmd.exe. Timeout, abort and result shape match pi's.
 */
export async function runFallbackShell(
  command: string,
  cwd: string,
  options: { timeout?: number; signal?: AbortSignal } = {}
): Promise<FallbackResult> {
  const shell = fallbackShell(command);

  return new Promise((resolve) => {
    const child = spawn(shell.file, shell.args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      ...(shell.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });

    let stdout = "";
    let stderr = "";
    let killed = false;

    const kill = (): void => {
      if (killed) return;

      killed = true;
      child.kill("SIGTERM");
      // A wedged command ignores SIGTERM; the deadline has already passed, so
      // there is nothing left to be polite about.
      setTimeout(() => child.kill("SIGKILL"), 5_000).unref();
    };

    const timer =
      options.timeout != null && options.timeout > 0
        ? setTimeout(kill, options.timeout)
        : undefined;

    if (options.signal?.aborted === true) kill();
    else options.signal?.addEventListener("abort", kill, { once: true });

    child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));

    const settle = (code: number): void => {
      if (timer != null) clearTimeout(timer);
      options.signal?.removeEventListener("abort", kill);
      resolve({ stdout, stderr, code, killed });
    };

    // A signal-killed process has no exit code; reporting 0 would tell the
    // caller a timed-out command passed. settleOnExit can drop a few trailing
    // bytes on a starved event loop, which is the right way round: a truncated
    // tail costs a little context; waiting for `close` can hold a turn for
    // minutes.
    settleOnExit(child, (exitCode) => settle(exitCode ?? 1));
    // ENOENT and friends: the command never ran, which is a failure like any
    // other as far as the caller is concerned.
    child.on("error", (error) => {
      stderr += `${error.message}\n`;
      settle(1);
    });
  });
}

/** Marks where the profile's own chatter ends and the environment dump begins. */
const SENTINEL = "__ABACUSAI_BOT_ENV__";

/**
 * Shells the dump script works in: all take `-l -c` and their printf emits a
 * NUL for `\0`. fish's printf escapes differ, so fish users fall back to bash.
 */
const DUMP_SHELLS = new Set(["bash", "zsh", "sh", "dash"]);

/**
 * The shell whose profile to source: the user's own login shell. Dumping via
 * bash on a zsh machine reads the wrong profile; on default macOS Homebrew's
 * PATH lives in ~/.zprofile, which bash never sources.
 */
export function dumpShell(): string {
  const shell = process.env.SHELL;
  if (shell != null && DUMP_SHELLS.has(path.basename(shell))) return shell;

  return "/bin/bash";
}

const VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

let resolved: NodeJS.ProcessEnv | undefined;

/**
 * The environment a login shell would provide, resolved once and cached. Falls
 * back to this process's own environment when the profile cannot be read: a
 * worse PATH is recoverable, refusing to run commands is not.
 */
export function loginEnvironment(): NodeJS.ProcessEnv {
  if (resolved !== undefined) return resolved;

  // Nothing to resolve: the caller wants the profile sourced per command
  // anyway, or there is no POSIX shell to source it with.
  if (loginShellRequested() || process.platform === "win32") {
    resolved = process.env;

    return resolved;
  }

  try {
    // NUL-delimited because a value may contain a newline. stderr is discarded:
    // the profile's own complaints are expected here. The sentinel matters:
    // profiles print banners to stdout, which would glue onto the first
    // variable (often PATH) and silently lose it.
    const printed = execFileSync(
      dumpShell(),
      // Separate flags: not every supported shell accepts "-lc" combined.
      ["-l", "-c", `printf '%s\\0' ${SENTINEL}; env -0`],
      {
        encoding: "utf8",
        timeout: 10_000,
        stdio: ["ignore", "pipe", "ignore"],
      }
    );

    const marker = printed.indexOf(`${SENTINEL}\0`);
    const dump =
      marker >= 0 ? printed.slice(marker + SENTINEL.length + 1) : printed;
    const shell: NodeJS.ProcessEnv = {};

    for (const entry of dump.split("\0")) {
      const separator = entry.indexOf("=");

      if (separator <= 0) continue;

      const name = entry.slice(0, separator);

      // A malformed name means the parse drifted (an uncaught banner, a value
      // containing a NUL); a bogus variable is worse than a missing one.
      if (!VARIABLE_NAME.test(name)) continue;

      shell[name] = entry.slice(separator + 1);
    }

    // This process's environment wins: a keychain-resolved API key must not be
    // replaced by a stale one from a profile. PATH is merged rather than
    // replaced, since the desktop's own PATH repair must survive the dump.
    resolved = {
      ...shell,
      ...process.env,
      ...(shell.PATH != null
        ? { PATH: mergePath(shell.PATH, process.env.PATH) ?? shell.PATH }
        : {}),
    };
  } catch {
    resolved = process.env;
  }

  return resolved;
}

/**
 * One PATH from two, keeping `front`'s entries in front and dropping repeats.
 * Neither half can simply win: pi prepends its own bin directory, and the rest
 * of pi's PATH is the launchd one that cannot find the user's toolchain.
 */
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

/** Forget the cached environment. Tests only; the profile does not change. */
export function resetLoginEnvironment(): void {
  resolved = undefined;
}
