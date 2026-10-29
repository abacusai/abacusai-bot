/**
 * The agent's side of the bundled POSIX shell: pi's bash operations pointed at
 * it, and what the model is told about the shell it has. The install itself is
 * `posix-shell-install.ts`, which the desktop imports on its own.
 */
import { spawn, spawnSync } from "node:child_process";
import { lstatSync } from "node:fs";
import { access } from "node:fs/promises";
import * as path from "node:path";

import { createLocalBashOperations } from "@earendil-works/pi-coding-agent";

import { MANAGED_PYTHON_ENV } from "./child-env.js";
import { modelPath } from "./model-path.js";
import {
  commandPosixShell,
  posixShell,
  posixShellEnv,
  type PosixShell,
} from "./posix-shell-install.js";
import { trashShimEnv } from "./trash.js";

export {
  BUSYBOX_LINKED_APPLETS,
  BUSYBOX_PAYLOAD,
  BUSYBOX_PREFER_EXTERNAL,
  BUSYBOX_VERSION,
  busyboxOverrideApplets,
  commandPosixShell,
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
 * Unless a shell is pinned, each command runs under the one current when it
 * starts (`commandPosixShell`), so a launcher removed mid-session is
 * reinstalled rather than failing every command after it.
 */
export function posixShellOperations(
  pinned?: PosixShell
): ShellOperations | null {
  if (pinned != null) return shellOperations(pinned);
  if (posixShell() == null) return null;

  return {
    exec: (command, cwd, options) => {
      const shell = commandPosixShell();

      return shell == null
        ? createLocalBashOperations().exec(command, cwd, options)
        : shellOperations(shell).exec(command, cwd, options);
    },
  };
}

/** The operations for one resolved shell. */
function shellOperations(shell: PosixShell): ShellOperations {
  if (shell.args != null) {
    const args = shell.args;
    return {
      exec: async (command, cwd, options) => {
        if (options.signal?.aborted) throw new Error("aborted");
        try {
          await access(cwd);
        } catch {
          throw new Error(
            `Working directory does not exist: ${modelPath(cwd)}\nCannot execute bash commands.`
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
          // The trash launchers go ahead of the applets (trash.ts).
          env: trashShimEnv(posixShellEnv(options.env ?? process.env, shell)),
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
        env: trashShimEnv(posixShellEnv(options.env ?? process.env, shell)),
      }),
  };
}

const WINDOWS_SHELL_PROMPT = [
  "# Windows shell",
  "`bash` runs busybox ash on Windows, not bash, WSL or MSYS. Pipes, `&&`, redirects, `$(...)`,",
  "heredocs and grep/sed/awk/find/head/tail/wc/sort/xargs work; arrays, `**` and some GNU flags",
  "do not. Write POSIX shell in it, never cmd.exe or PowerShell syntax.",
  "- Paths are native, with forward slashes: 'C:/Users/Name/project'. /c/..., /mnt/c and",
  "  /cygdrive/c do not exist. Quote any path with a space ('C:/Program Files/...'). Avoid",
  '  backslashes: unquoted they vanish, and a trailing one inside "..." escapes the quote.',
  '- There is no /tmp. Scratch files go in "$TMPDIR" (the Windows temp dir; mktemp uses it).',
  "- Installed programs are on PATH and take Windows arguments (npm is npm.cmd).",
  "  Look one up with `command -v name`, not `where`.",
  "- There is no nohup, setsid, mount, file, lsof or top. For a long job, use the `background`",
  "  parameter of `bash` where it has one.",
  "- Variables are `$NAME` and `export NAME=value`, never `%NAME%`.",
  "- PowerShell: single-quote the whole program and write PowerShell inside it, double quotes",
  "  for its strings: powershell -NoProfile -Command 'Get-Item \"C:/x y\" | Select-Object Name'.",
  '  For more than a line, write a .ps1 into "$TMPDIR" and run powershell -NoProfile',
  "  -ExecutionPolicy Bypass -File on it. Prefer ash when it can do the job.",
].join("\n");

/** Only for the ANSI build, which this Windows needs because it predates the Unicode one. */
const ANSI_SHELL_PROMPT = [
  "- This Windows is too old for the Unicode shell, so command text outside the system code",
  "  page (other scripts, emoji) arrives as '?'. Put such text in a file with the write tool",
  "  and have the command read the file.",
].join("\n");

/**
 * The interpreters and build tools a model reaches for without checking. A
 * stock Windows has none of them, and a model that assumes `python3` or `node`
 * spends turns on "not found" (or rewrites the work in sed) before it looks.
 */
export const WINDOWS_TOOLCHAIN: readonly string[] = [
  "python",
  "python3",
  "py",
  "pip",
  "node",
  "npm",
  "npx",
  "git",
  "curl",
  "php",
  "dotnet",
  "java",
  "perl",
  "ruby",
  "pwsh",
];

/**
 * The app's own Python environment, which the desktop names (and puts first on
 * PATH) when the machine has no usable Python; null otherwise.
 */
export function managedPythonEnv(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const dir = (env[MANAGED_PYTHON_ENV] ?? "").trim();

  return dir.length > 0 ? dir : null;
}

/** That environment's executables directory, or null. */
export function managedPythonBin(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const dir = managedPythonEnv(env);
  if (dir == null) return null;

  return path.join(dir, platform === "win32" ? "Scripts" : "bin");
}

/**
 * What the model is told about running scripts: the app's own Node, with the
 * document libraries, wherever the agent runs on it; and the app's own Python
 * where the machine has none. Null when neither applies.
 */
export function scriptRuntimesPrompt(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): string | null {
  const lines: string[] = [];
  if ((env.ABACUSAI_BOT_NODE ?? "") !== "")
    lines.push(
      "- Word and Excel files: write a CommonJS script (`.cjs`) and run it with",
      '  `"$ABACUSAI_BOT_NODE" script.cjs`, this app\'s own Node. `require()` finds `docx`, `mammoth`,',
      "  `exceljs` and `jszip` with nothing to install; the docx and xlsx skills show how. PDFs go",
      "  through the pdf tool."
    );
  if (managedPythonEnv(env) != null)
    lines.push(
      `- ${platform === "win32" ? "`python` and `pip`" : "`python3`, `python` and `pip`"} run this app's own Python 3; the machine has no usable`,
      "  Python of its own. The first command that uses it downloads it, which can take a minute or",
      "  two. `pip install` adds packages to it, for analysis and scripts of your own."
    );

  return lines.length > 0 ? ["# Running scripts", ...lines].join("\n") : null;
}

/** What ash finds on PATH without an extension. */
const COMMAND_EXTENSIONS = [".exe", ".com", ".cmd", ".bat"];

/** How the inventory looks at the machine; the tests swap it. */
export interface ToolchainProbe {
  /** The first file PATH resolves `name` to, or undefined. */
  find: (name: string, pathValue: string) => string | undefined;
  /** Whether `file --version` runs: an App Installer alias only offers the Store. */
  runs: (file: string) => boolean;
}

const defaultProbe: ToolchainProbe = {
  find: (name, pathValue) => {
    for (const dir of pathValue.split(";")) {
      if (dir.length === 0) continue;
      for (const extension of COMMAND_EXTENSIONS) {
        const file = path.join(dir, `${name}${extension}`);
        try {
          // lstat: an app execution alias is a reparse point stat cannot open.
          lstatSync(file);
          return file;
        } catch {
          // Not here; the next directory may have it.
        }
      }
    }

    return undefined;
  },
  runs: (file) => {
    const probe = spawnSync(file, ["--version"], {
      stdio: "ignore",
      timeout: 5_000,
      windowsHide: true,
    });

    return probe.error == null && probe.status === 0;
  },
};

/**
 * Which of `WINDOWS_TOOLCHAIN` the shell's commands can run, on the PATH they
 * get. A hit under WindowsApps is run once: with no Python installed, Windows
 * puts `python.exe` and `python3.exe` aliases there that print a Store hint.
 */
export function windowsToolchain(
  shell: PosixShell,
  env: NodeJS.ProcessEnv = process.env,
  probe: ToolchainProbe = defaultProbe
): { present: string[]; missing: string[] } {
  const pathValue = posixShellEnv(env, shell).PATH ?? "";
  // Set up on first use, so it may not be on disk yet.
  const managed = managedPythonEnv(env) != null ? ["python", "pip"] : [];
  const present: string[] = [];
  const missing: string[] = [];
  for (const name of WINDOWS_TOOLCHAIN) {
    const file = probe.find(name, pathValue);
    const usable =
      managed.includes(name) ||
      (file != null &&
        (!/[\\/]WindowsApps[\\/]/i.test(file) || probe.runs(file)));
    (usable ? present : missing).push(name);
  }

  return { present, missing };
}

/** The inventory as prompt lines: what is there, what is not, and how to start Python. */
export function toolchainPrompt(toolchain: {
  present: readonly string[];
  missing: readonly string[];
}): string {
  const has = new Set(toolchain.present);
  const lines = [
    "- On PATH when this session started:",
    `  ${toolchain.present.length > 0 ? toolchain.present.join(", ") : "none of the usual interpreters"}.`,
    ...(toolchain.missing.length > 0
      ? [
          "- Not on PATH, so do not call them:",
          `  ${toolchain.missing.join(", ")}.`,
          "  Use what is there or a project's own copy (.venv/Scripts/python.exe,",
          "  node_modules/.bin), or tell the user what to install.",
        ]
      : []),
  ];
  if (!has.has("python3") && (has.has("python") || has.has("py")))
    lines.push(
      `- There is no python3 here: run Python as \`${has.has("python") ? "python" : "py -3"}\`.`
    );

  return lines.join("\n");
}

let inventory: { sh: string; prompt: string } | undefined;

/** Taken once per shell per process, so the system prompt stays byte-stable for the provider's cache. */
function cachedToolchainPrompt(shell: PosixShell): string {
  if (inventory?.sh !== shell.sh)
    inventory = {
      sh: shell.sh,
      prompt: toolchainPrompt(windowsToolchain(shell)),
    };

  return inventory.prompt;
}

/** Test seam: forget the inventory. */
export function resetToolchainForTesting(): void {
  inventory = undefined;
}

/**
 * What the model needs to know about the shell it has, or null where it has a
 * real bash: which build it is, and which interpreters it can call.
 */
export function windowsShellPrompt(
  shell: PosixShell | undefined = posixShell(),
  toolchain: string = shell == null ? "" : cachedToolchainPrompt(shell)
): string | null {
  if (shell == null) return null;

  return [
    WINDOWS_SHELL_PROMPT,
    ...(shell.ansi === true ? [ANSI_SHELL_PROMPT] : []),
    ...(toolchain.length > 0 ? [toolchain] : []),
  ].join("\n");
}
