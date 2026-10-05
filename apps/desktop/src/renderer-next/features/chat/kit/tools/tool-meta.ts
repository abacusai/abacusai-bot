/**
 * The step row's meta column (spec 02 §5.4), pure: `+a -d` for edits,
 * "lines a to b" for reads, "{n} matches" for greps, elapsed or the exit
 * status for bash, nothing otherwise.
 */
import { toToolKind, type ToolKind } from "@abacus-ai/agent/tool-display";

import { countChanges, type NormalizedTool } from "./normalize";

export type ToolMeta =
  | { kind: "changes"; additions: number; deletions: number }
  | { kind: "lines"; from: number; to: number }
  | { kind: "matches"; count: number }
  | { kind: "elapsed"; since: number }
  | { kind: "exit"; code: number }
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
  firstSeenAt: number | null
): ToolMeta => {
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
      return { kind: "elapsed", since: firstSeenAt };
    if (tool.terminal?.exitCode != null && tool.terminal.exitCode !== 0)
      return { kind: "exit", code: tool.terminal.exitCode };
    const exit = /exit(?:ed with)? code (\d+)/i.exec(tool.text);
    if (tool.status === "failed" && exit != null)
      return { kind: "exit", code: Number(exit[1]) };
  }
  return null;
};
