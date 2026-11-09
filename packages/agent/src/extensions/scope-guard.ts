/**
 * Keeping an unwatched sub-agent on the folder its task is about. A sub-agent
 * that cannot find something in its repo will search the disk for it, and
 * the user's other files are full of plausible stand-ins: another checkout of
 * the same project, an older version, someone else's fork. Its report then
 * describes code the parent never asked about, and nobody saw it happen.
 *
 * In scope: the task's root, anything the task text names, the run's own
 * skill files, the temp folder, and system folders outside home (toolchains,
 * /etc). Readable but not writable: the toolchain and package-cache folders
 * in home, where a dependency's source often lives (~/.nvm, ~/.cargo, ...).
 * Out of scope: the rest of home, and searches that start above it.
 * Deliberately syntactic, like the guardrails: it keeps an honest model on
 * task, it is not a sandbox against one built to evade it.
 */
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import { modelPath } from "../model-path.js";
import { judgeCommand, type Judgement } from "../shell-judge.js";
import {
  isInsideDirectory,
  realPathOf,
  resolveInWorkspace,
} from "../workspace-path.js";

export interface TaskScope {
  root: string;
  /** Further files or folders the run may use: named in the task, its skills. */
  allowed: string[];
  /** Paths the guard refused, in order, for the report to the parent. */
  refused: string[];
  /** The user's home folder; everything in it is someone's other work. */
  home: string;
  /** The platform temp folder: in scope, though on Windows it is inside home. */
  temp: string;
}

/** Absolute, drive and `~/` paths written in the task text, trailing punctuation dropped. */
export function pathsNamedIn(task: string): string[] {
  const found =
    task.match(
      /(?<![\w.:/\\~])(?:~[\\/]|\/|[A-Za-z]:[\\/])[^\s"'`<>()[\]{},;]+/g
    ) ?? [];

  return found
    .map((raw) => raw.replace(/[.:!?]+$/, ""))
    .filter((raw) => raw.length > 1)
    .map((raw) => resolveInWorkspace(raw.replace(/^~\\/, "~/"), "/"));
}

export function taskScope(
  root: string,
  task: string,
  alsoAllowed: string[] = [],
  machine: { home: string; temp: string } = {
    home: os.homedir(),
    temp: os.tmpdir(),
  }
): TaskScope {
  return {
    root: path.resolve(root),
    allowed: [...pathsNamedIn(task), ...alsoAllowed],
    refused: [],
    home: realPathOf(machine.home) ?? machine.home,
    temp: machine.temp,
  };
}

/**
 * Folders in home that hold installed toolchains and package caches: the
 * source of a dependency the task asks about is often only here. Read-only:
 * a sub-agent has no business changing what other projects install from.
 */
export const TOOLCHAIN_DIRS = [
  ".nvm",
  ".fnm",
  ".local/share/fnm",
  "Library/Application Support/fnm",
  ".volta",
  ".asdf",
  ".bun",
  ".deno",
  ".npm",
  ".yarn",
  ".pnpm-store",
  ".local/share/pnpm",
  "Library/pnpm",
  "AppData/Roaming/npm",
  "AppData/Local/pnpm",
  ".cargo",
  ".rustup",
  "go/pkg/mod",
  ".pyenv",
  ".local/lib",
  ".local/pipx",
  ".cache/pip",
  ".rbenv",
  ".gem",
  ".m2",
  ".gradle",
  ".sdkman",
];

export type Access = "read" | "write";

/** Whether a path the run reached for lies outside its scope. */
export function outsideScope(
  target: string,
  cwd: string,
  scope: TaskScope,
  access: Access = "read"
): boolean {
  const abs = resolveInWorkspace(target, cwd);
  if (isInsideDirectory(abs, scope.root)) return false;
  if (scope.allowed.some((allowed) => isInsideDirectory(abs, allowed)))
    return false;

  const real = realPathOf(abs);
  // Unresolvable (a link loop): not known to be anywhere, so refuse.
  if (real === null) return true;
  if (isInsideDirectory(real, scope.temp)) return false;
  if (
    access === "read" &&
    TOOLCHAIN_DIRS.some((dir) =>
      isInsideDirectory(real, path.join(scope.home, dir))
    )
  )
    return false;

  // The rest of home is the user's other work; a folder above home is a
  // search that sweeps it.
  return (
    isInsideDirectory(real, scope.home) || isInsideDirectory(scope.home, real)
  );
}

/** Absolute (POSIX or a Windows drive), home-rooted, or climbing out. */
const LOOKS_LIKE_PATH = /^(?:\/|~(?:[\\/]|$)|[A-Za-z]:[\\/]|\.\.(?:[\\/]|$))/;

/**
 * The path operands of a shell command: every argument or redirect file of a
 * command this machine runs that is absolute, home-rooted or climbs with
 * `..`, including the value of a `--flag=/path`. The verb itself is skipped,
 * so running a tool by its full path is not a read of that path.
 */
export function shellPathOperands(
  command: string,
  cwd: string = process.cwd(),
  judgement: Judgement = judgeCommand(command, { cwd })
): string[] {
  const operands: string[] = [];
  for (const local of judgement.commands) {
    for (const word of [...local.args, ...local.redirects]) {
      const value = word.startsWith("-") ? (word.split("=")[1] ?? "") : word;
      if (LOOKS_LIKE_PATH.test(value)) operands.push(value);
    }
  }
  return operands;
}

/** The paths one tool call reaches for, and how; empty for tools that touch none. */
export function targetsOf(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string = process.cwd()
): Array<{ path: string; access: Access }> {
  switch (toolName) {
    case "read":
    case "ls":
    case "grep":
    case "find":
      return typeof input.path === "string"
        ? [{ path: input.path, access: "read" }]
        : [];
    case "write":
    case "edit":
      return typeof input.path === "string"
        ? [{ path: input.path, access: "write" }]
        : [];
    case "bash": {
      if (typeof input.command !== "string") return [];
      // Operands are judged as reads, except the ones the shell judge says
      // the command writes to.
      const judgement = judgeCommand(input.command, { cwd });
      const writes = judgement.localWrites.map((write) => write.target);
      const operands = new Set([
        ...shellPathOperands(input.command, cwd, judgement),
        ...writes.filter((target) => LOOKS_LIKE_PATH.test(target)),
      ]);
      return [...operands].map((operand) => ({
        path: operand,
        access: writes.includes(operand) ? "write" : "read",
      }));
    }
    default:
      return [];
  }
}

export function refusal(target: string, scope: TaskScope): string {
  return (
    `${modelPath(target)} is outside ${modelPath(scope.root)}, the folder this task is about. Work with what is ` +
    "there and with paths the task names. If something you need is missing, say so in your " +
    "report instead of looking for it elsewhere on this machine."
  );
}

/** The extension: refuses out-of-scope paths and records them in `scope.refused`. */
export function scopeGuard(scope: TaskScope): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const outside = targetsOf(event.toolName, input, ctx.cwd).find((target) =>
        outsideScope(target.path, ctx.cwd, scope, target.access)
      );
      if (outside == null) return;

      scope.refused.push(outside.path);
      return { block: true, reason: refusal(outside.path, scope) };
    });
  };
}
