/**
 * Keeping an unwatched sub-agent on the folder its task is about. A sub-agent
 * that cannot find something in its repo will search the disk for it, and
 * the user's other files are full of plausible stand-ins: another checkout of
 * the same project, an older version, someone else's fork. Its report then
 * describes code the parent never asked about, and nobody saw it happen.
 *
 * In scope: the task's root, anything the task text names, the run's own
 * skill files, the temp folder, and system folders outside home (toolchains,
 * /etc). Out of scope: the rest of home, and searches that start above it.
 * Deliberately syntactic, like the guardrails: it keeps an honest model on
 * task, it is not a sandbox against one built to evade it.
 */
import * as os from "node:os";
import * as path from "node:path";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

import {
  isInsideDirectory,
  realPathOf,
  resolveInWorkspace,
} from "../workspace-path.js";
import { SEGMENT_SPLIT, shellWords, WRAPPER_COMMANDS } from "./guardrails.js";

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

/** Absolute and `~/` paths written in the task text, trailing punctuation dropped. */
export function pathsNamedIn(task: string): string[] {
  const found =
    task.match(/(?<![\w.:/~])(?:~\/|\/)[^\s"'`<>()[\]{},;]+/g) ?? [];

  return found
    .map((raw) => raw.replace(/[.:!?]+$/, ""))
    .filter((raw) => raw.length > 1)
    .map((raw) => resolveInWorkspace(raw, "/"));
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

/** Whether a path the run reached for lies outside its scope. */
export function outsideScope(
  target: string,
  cwd: string,
  scope: TaskScope
): boolean {
  const abs = resolveInWorkspace(target, cwd);
  if (isInsideDirectory(abs, scope.root)) return false;
  if (scope.allowed.some((allowed) => isInsideDirectory(abs, allowed)))
    return false;

  const real = realPathOf(abs);
  // Unresolvable (a link loop): not known to be anywhere, so refuse.
  if (real === null) return true;
  if (isInsideDirectory(real, scope.temp)) return false;

  // The rest of home is the user's other work; a folder above home is a
  // search that sweeps it.
  return (
    isInsideDirectory(real, scope.home) || isInsideDirectory(scope.home, real)
  );
}

/**
 * The path operands of a shell command: every word after the verb that is
 * absolute, `~`-rooted, `$HOME`-rooted or climbs with `..`, including the
 * value of a `--flag=/path`. The verb itself is skipped, so running a tool
 * by its full path is not a read of that path.
 */
export function shellPathOperands(command: string): string[] {
  const operands: string[] = [];

  for (const segment of command.split(SEGMENT_SPLIT)) {
    const words = shellWords(segment);
    let index = 0;
    while (
      index < words.length &&
      (WRAPPER_COMMANDS.has(words[index]!) || /^\w+=/.test(words[index]!))
    )
      index += 1;

    for (const word of words.slice(index + 1)) {
      // `2>/dev/null`, `<in.txt`: the redirect's file is an operand too.
      const unredirected = word.replace(/^(?:\d*|&)(?:>>?|<)/, "");
      const value = unredirected.startsWith("-")
        ? (unredirected.split("=")[1] ?? "")
        : unredirected;
      const expanded = value.replace(/^\$\{?HOME\}?(?=\/|$)/, "~");
      if (
        expanded.startsWith("/") ||
        expanded === "~" ||
        expanded.startsWith("~/") ||
        expanded === ".." ||
        expanded.startsWith("../")
      )
        operands.push(expanded);
    }
  }

  return operands;
}

/** The paths one tool call reaches for; empty for tools that touch none. */
function targetsOf(toolName: string, input: Record<string, unknown>): string[] {
  switch (toolName) {
    case "read":
    case "write":
    case "edit":
    case "ls":
    case "grep":
    case "find":
      return typeof input.path === "string" ? [input.path] : [];
    case "bash":
      return typeof input.command === "string"
        ? shellPathOperands(input.command)
        : [];
    default:
      return [];
  }
}

export function refusal(target: string, scope: TaskScope): string {
  return (
    `${target} is outside ${scope.root}, the folder this task is about. Work with what is ` +
    "there and with paths the task names. If something you need is missing, say so in your " +
    "report instead of looking for it elsewhere on this machine."
  );
}

/** The extension: refuses out-of-scope paths and records them in `scope.refused`. */
export function scopeGuard(scope: TaskScope): (pi: ExtensionAPI) => void {
  return (pi) => {
    pi.on("tool_call", async (event, ctx) => {
      const input = (event.input ?? {}) as Record<string, unknown>;
      const outside = targetsOf(event.toolName, input).find((target) =>
        outsideScope(target, ctx.cwd, scope)
      );
      if (outside == null) return;

      scope.refused.push(outside);
      return { block: true, reason: refusal(outside, scope) };
    });
  };
}
