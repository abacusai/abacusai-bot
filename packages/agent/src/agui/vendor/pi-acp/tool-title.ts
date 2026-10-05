/**
 * Vendored from pi-acp (MIT, Copyright (c) 2025 Victor Software House; see
 * ./LICENSE), src/acp/session.ts:92-149 at commit
 * 0ef24b24c97ac81a5e87a17d8fd74ef97fb34d8b.
 *
 * Changes: our tool set (grep, find/glob, ls, web_fetch, web_search,
 * delegate_task, browser_task, ast_edit, batch_edit, batch_file_read, todo,
 * memory, document/pdf/ppt/design/app); lsp, tmux, context_* and claudemon
 * dropped. Browser-safe: no node or pi imports.
 */

export type ToolArgs = Record<string, unknown>;

const MAX_TITLE_LEN = 80;

function truncateTitle(text: string): string {
  const oneLine = text.replace(/\n/g, " ").trim();
  if (oneLine.length <= MAX_TITLE_LEN) return oneLine;
  return `${oneLine.slice(0, MAX_TITLE_LEN - 1)}…`;
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined;

/**
 * A short human-readable label from a tool name and its (final) input, like
 * "Read src/index.ts" or "Run ls -la".
 */
export function buildToolTitle(toolName: string, args: ToolArgs): string {
  const p = str(args.path) ?? str(args.file_path);

  switch (toolName) {
    case "read":
      return p !== undefined ? `Read ${p}` : "Read";
    case "write":
      return p !== undefined ? `Write ${p}` : "Write";
    case "edit":
      return p !== undefined ? `Edit ${p}` : "Edit";
    case "ast_edit":
      return p !== undefined ? `Edit ${p}` : "Structural edit";
    case "batch_edit":
      return "Edit files";
    case "batch_file_read":
      return "Read files";
    case "ls":
      return p !== undefined ? `List ${p}` : "List files";
    case "bash": {
      const command = str(args.command) ?? str(args.cmd);
      return command !== undefined ? truncateTitle(`Run ${command}`) : "bash";
    }
    case "grep": {
      const pattern = str(args.pattern);
      return pattern !== undefined
        ? truncateTitle(`Search ${pattern}${p !== undefined ? ` in ${p}` : ""}`)
        : "Search";
    }
    case "find":
    case "glob": {
      const pattern = str(args.pattern);
      return pattern !== undefined ? truncateTitle(`Find ${pattern}`) : "Find files";
    }
    case "web_fetch": {
      const url = str(args.url);
      return url !== undefined ? truncateTitle(`Fetch ${url}`) : "Fetch";
    }
    case "web_search": {
      const query = str(args.query);
      return query !== undefined ? truncateTitle(`Search the web for ${query}`) : "Search the web";
    }
    case "delegate_task": {
      const task = str(args.task);
      return task !== undefined ? truncateTitle(`Delegate: ${task}`) : "Delegate";
    }
    case "browser_task": {
      const task = str(args.task) ?? str(args.goal);
      return task !== undefined ? truncateTitle(`Browse: ${task}`) : "Browse";
    }
    case "todo":
      return args.action === "list" ? "Read plan" : "Update plan";
    case "memory":
      return "Memory";
    case "document":
    case "pdf":
      return "Write document";
    case "ppt":
      return "Build deck";
    case "design":
      return "Design";
    case "app":
      return "Build app";
    default:
      return toolName;
  }
}
