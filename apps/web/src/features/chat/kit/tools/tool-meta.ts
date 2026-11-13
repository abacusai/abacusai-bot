/**
 * The step row's meta column (spec 02 §5.4), pure: `+a -d` for edits,
 * "lines a to b" for reads, "{n} matches" for greps, elapsed or the exit
 * status for bash, nothing otherwise.
 */
import { progressOf } from "@abacus-ai/agent/terminal-progress";
import { toToolKind, type ToolKind } from "@abacus-ai/agent/tool-display";

import { resolveWorkspacePath } from "#renderer/components/file-preview/paths";

import { countChanges, todoItems, type NormalizedTool } from "./normalize";

export type ToolMeta =
  | { kind: "changes"; additions: number; deletions: number }
  | { kind: "lines"; from: number; to: number }
  | { kind: "matches"; count: number }
  | {
      kind: "elapsed";
      since: number;
      /** 0 to 100 when the output says how far it has got. */
      progress: number | null;
      /** When it last printed; `since` until it does. */
      quietSince: number;
    }
  | { kind: "exit"; code: number }
  | { kind: "todo"; done: number; total: number }
  | null;

const EDIT_TOOLS = new Set([
  "edit",
  "write",
  "ast_edit",
  "batch_edit",
  "notebook_edit",
]);

export const kindOf = (name: string): ToolKind => {
  try {
    return toToolKind(name);
  } catch {
    return "other";
  }
};

export const toolMeta = (
  name: string,
  input: Record<string, unknown>,
  tool: NormalizedTool,
  firstSeenAt: number | null,
  lastOutputAt: number | null = null
): ToolMeta => {
  if (name === "todo" || name === "todo_write") {
    const items = todoItems(input);
    if (items.length > 0)
      return {
        kind: "todo",
        done: items.filter((item) => item.status === "completed").length,
        total: items.length,
      };
  }
  if (EDIT_TOOLS.has(name) && tool.diff != null) {
    const counted =
      tool.diff.additions != null && tool.diff.deletions != null
        ? { additions: tool.diff.additions, deletions: tool.diff.deletions }
        : countChanges(tool.diff.original, tool.diff.final);
    return { kind: "changes", ...counted };
  }
  if (name === "read" && tool.read != null) {
    const from = typeof input.offset === "number" ? input.offset : 1;
    return {
      kind: "lines",
      from,
      to: from + Math.max(0, tool.read.lineCount - 1),
    };
  }
  if (name === "grep" && tool.status === "done") {
    const match = /^(?:Found )?(\d+) match(?:es)?/m.exec(tool.text);
    if (match != null) return { kind: "matches", count: Number(match[1]) };
  }
  if (name === "bash") {
    if (tool.status === "running" && firstSeenAt != null)
      return {
        kind: "elapsed",
        since: firstSeenAt,
        progress: progressOf(tool.terminal?.output ?? ""),
        quietSince: Math.max(firstSeenAt, lastOutputAt ?? firstSeenAt),
      };
    if (tool.terminal?.exitCode != null && tool.terminal.exitCode !== 0)
      return { kind: "exit", code: tool.terminal.exitCode };
    const exit = /exit(?:ed with)? code (\d+)/i.exec(tool.text);
    if (tool.status === "failed" && exit != null)
      return { kind: "exit", code: Number(exit[1]) };
  }
  return null;
};

/** Tools whose single `path` input is a file (or, for `ls`, a folder). */
const PATH_TOOLS = new Set([
  "read",
  "write",
  "edit",
  "ast_edit",
  "batch_edit",
  "notebook_edit",
  "delete",
  "apply_patch",
  "ls",
]);

/** The absolute path a file tool row opens, if it has exactly one. */
export const toolOpenPath = (
  name: string,
  input: Record<string, unknown>,
  workspaceRoot: string | null
): string | null => {
  if (!PATH_TOOLS.has(name)) return null;
  const raw = input.path ?? input.file_path ?? input.notebook_path;
  if (typeof raw !== "string" || raw.trim() === "") return null;
  return resolveWorkspacePath(raw.trim(), workspaceRoot);
};
