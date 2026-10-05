/**
 * Vendored from pi-acp (MIT, Copyright (c) 2025 Victor Software House; see
 * ./LICENSE), src/acp/session.ts:57-72 at commit
 * 0ef24b24c97ac81a5e87a17d8fd74ef97fb34d8b.
 *
 * Changes: the ACP ToolKind union is inlined (no SDK import) and the mapping
 * covers our tools. Browser-safe.
 */

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "switch_mode"
  | "other";

export function toToolKind(toolName: string): ToolKind {
  switch (toolName) {
    case "read":
    case "batch_file_read":
    case "ls":
      return "read";
    case "write":
    case "edit":
    case "ast_edit":
    case "batch_edit":
      return "edit";
    case "bash":
      return "execute";
    case "grep":
    case "find":
    case "glob":
    case "web_search":
      return "search";
    case "web_fetch":
      return "fetch";
    case "delegate_task":
      return "think";
    case "exit_plan_mode":
      return "switch_mode";
    default:
      return "other";
  }
}
