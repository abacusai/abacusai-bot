/**
 * The agent's side of the bundled POSIX shell: pi's bash operations pointed at
 * it, and what the model is told about the shell it has. The install itself is
 * `posix-shell-install.ts`, which the desktop imports on its own.
 */
import { spawn } from "node:child_process";
import { access } from "node:fs/promises";

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import {
  posixShell,
  posixShellEnv,
  type PosixShell,
} from "./posix-shell-install.js";

export {
  BUSYBOX_LINKED_APPLETS,
  BUSYBOX_PAYLOAD,
  BUSYBOX_PREFER_EXTERNAL,
  BUSYBOX_VERSION,
  busyboxOverrideApplets,
  findPayload,
  installPosixShell,
  posixShell,
  posixShellEnv,
  resetPosixShellForTesting,
  POSIX_SHELL_PAYLOAD_ENV,
} from "./posix-shell-install.js";
export type { InstallOptions, PosixShell } from "./posix-shell-install.js";

/**
 * pi's `BashOperations`, spelled here rather than imported: this module is on
 * the package's public surface, and a pi type there drags pi-ai's model data
 * into the declaration build, which cannot load it.
 */
export interface ShellOperations {
  exec: (
    command: string,
    cwd: string,
    options: {
      onData: (data: Buffer) => void;
      signal?: AbortSignal;
      timeout?: number;
      env?: NodeJS.ProcessEnv;
    }
  ) => Promise<{ exitCode: number | null }>;
}

/**
 * pi's local bash operations pointed at the bundled `sh`, with every child's
 * environment set here (including a background job's, which arrives without
 * one), so the applet directory never has to be on this process's own PATH.
 * Null where there is no bundled shell, so the caller keeps pi's own path.
 */
export function posixShellOperations(
  shell: PosixShell | undefined = posixShell()
): ShellOperations | null {
  if (shell == null) return null;
  if (shell.args != null) {
    const args = shell.args;
    return {
      exec: async (command, cwd, options) => {
        if (options.signal?.aborted) throw new Error("aborted");
        try {
          await access(cwd);
        } catch {
          throw new Error(
            `Working directory does not exist: ${cwd}\nCannot execute bash commands.`
          );
        }
        const timeout = options.timeout;
        if (
          timeout != null &&
          (!Number.isFinite(timeout) ||
            timeout <= 0 ||
            timeout * 1000 > 2_147_483_647)
        )
          throw new Error("Invalid timeout");
        const child = spawn(shell.sh, [...args, "-c", command], {
          cwd,
          env: posixShellEnv(options.env ?? process.env, shell),
          stdio: ["ignore", "pipe", "pipe"],
          windowsHide: true,
        });
        return new Promise<{ exitCode: number | null }>((resolve, reject) => {
          let settled = false;
          let timedOut = false;
          let grace: NodeJS.Timeout | undefined;
          const kill = () => child.kill();
          const timer =
            timeout == null
              ? undefined
              : setTimeout(() => {
                  timedOut = true;
                  kill();
                }, timeout * 1000);
          const finish = (code: number | null, error?: Error) => {
            if (settled) return;
            settled = true;
            if (timer != null) clearTimeout(timer);
            if (grace != null) clearTimeout(grace);
            options.signal?.removeEventListener("abort", kill);
            child.stdout?.destroy();
            child.stderr?.destroy();
            if (options.signal?.aborted) reject(new Error("aborted"));
            else if (timedOut) reject(new Error(`timeout:${timeout}`));
            else if (error != null) reject(error);
            else resolve({ exitCode: code });
          };
          child.stdout?.on("data", options.onData);
          child.stderr?.on("data", options.onData);
          child.on("error", (error) => finish(null, error));
          child.on("exit", (code) => {
            // A background child may inherit the pipes after ash exits.
            grace = setTimeout(() => finish(code), 100);
            grace.unref();
          });
          child.on("close", (code) => finish(code));
          if (options.signal?.aborted) kill();
          else options.signal?.addEventListener("abort", kill, { once: true });
        });
      },
    };
  }
  const local = createLocalBashOperations({ shellPath: shell.sh });

  return {
    exec: (command, cwd, options) =>
      local.exec(command, cwd, {
        ...options,
        env: posixShellEnv(options.env ?? process.env, shell),
      }),
  };
}

const WINDOWS_SHELL_PROMPT = [
  "# Windows shell",
  "`bash` runs in a POSIX shell (busybox ash) on Windows: pipes, `&&`, redirects, `$(...)`,",
  "heredocs and grep/sed/awk/find/head/tail/wc/sort all work. Ignore any advice to use cmd.exe",
  "or PowerShell syntax in it.",
  "- Paths are native Windows paths, not WSL: there is no /mnt/c. Write them quoted, with",
  "  forward slashes and the drive letter: 'C:/Users/Name With Spaces/project'. An unquoted",
  "  backslash is a shell escape.",
  "- ash is not GNU bash: no arrays, no `**` globstar, and busybox's coreutils lack some GNU",
  "  flags. Installed Windows programs (node, python, git, npm.cmd) are on PATH and take",
  "  Windows arguments.",
  "- Variables are `$NAME` and `export NAME=value`, never `%NAME%`. To run PowerShell, call",
  "  `powershell.exe -NoProfile -Command '...'` with the program single-quoted.",
].join("\n");

/** What the model needs to know about the shell it has, or null where it has a real bash. */
export function windowsShellPrompt(
  shell: PosixShell | undefined = posixShell()
): string | null {
  return shell == null ? null : WINDOWS_SHELL_PROMPT;
}
