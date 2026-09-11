import type { ToolRenderItem, ToolRenderState } from "./render-utils";

export type ToolGroupAction =
  | "read"
  | "edit"
  | "command"
  | "code-search"
  | "search"
  | "other";

const READ_TOOLS = new Set(["read", "ls", "image_view"]);
const EDIT_TOOLS = new Set([
  "write",
  "edit",
  "batch_edit",
  "notebook_edit",
  "delete",
  "apply_patch",
]);
const COMMAND_TOOLS = new Set([
  "bash",
  "bash_output",
  "kill_shell",
  "exec_command",
]);
const CODE_SEARCH_TOOLS = new Set(["glob", "grep", "codebase_search"]);
const WEB_SEARCH_TOOLS = new Set(["web_search", "web_fetch"]);

export function toolGroupAction(tool: ToolRenderItem): ToolGroupAction {
  if (READ_TOOLS.has(tool.name)) return "read";
  if (EDIT_TOOLS.has(tool.name)) return "edit";
  if (COMMAND_TOOLS.has(tool.name)) return "command";
  if (CODE_SEARCH_TOOLS.has(tool.name)) return "code-search";
  if (WEB_SEARCH_TOOLS.has(tool.name)) return "search";
  return "other";
}

function toolFilePath(tool: ToolRenderItem): string | null {
  for (const key of ["file_path", "path", "filepath", "notebook_path"]) {
    const value = tool.input[key];
    if (typeof value === "string" && value.trim().length > 0)
      return value.trim();
  }
  return null;
}

function actionCount(
  action: ToolGroupAction,
  tools: readonly ToolRenderItem[]
): number {
  if (action !== "edit") return tools.length;

  const paths = new Set<string>();
  let editsWithoutPath = 0;
  for (const tool of tools) {
    const path = toolFilePath(tool);
    if (path) paths.add(path);
    else editsWithoutPath += 1;
  }
  return paths.size + editsWithoutPath;
}

function settledActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Read ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changed ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Ran ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searched the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searched code ${count} ${count === 1 ? "time" : "times"}`;
    case "other":
      return `Used ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

function runningActionLabel(action: ToolGroupAction, count: number): string {
  switch (action) {
    case "read":
      return `Reading ${count} ${count === 1 ? "file" : "files"}`;
    case "edit":
      return `Changing ${count} ${count === 1 ? "file" : "files"}`;
    case "command":
      return `Running ${count} ${count === 1 ? "command" : "commands"}`;
    case "search":
      return `Searching the web ${count} ${count === 1 ? "time" : "times"}`;
    case "code-search":
      return `Searching code ${count === 1 ? "" : `${count} times`}`.trim();
    case "other":
      return `Using ${count} ${count === 1 ? "tool" : "tools"}`;
  }
}

function sentenceJoin(labels: string[]): string {
  const normalized = labels.map((label, index) =>
    index === 0 ? label : `${label.charAt(0).toLowerCase()}${label.slice(1)}`
  );
  if (normalized.length < 2) return normalized[0] ?? "";
  if (normalized.length === 2) return normalized.join(" and ");
  return `${normalized.slice(0, -1).join(", ")}, and ${normalized.at(-1)}`;
}

export function toolGroupState(
  tools: readonly ToolRenderItem[]
): ToolRenderState {
  if (tools.some((tool) => tool.state === "running")) return "running";
  if (tools.some((tool) => tool.state === "error")) return "error";
  return "done";
}

export function toolGroupSummaryKind(
  tools: readonly ToolRenderItem[]
): ToolGroupAction | "mixed" {
  const actions = new Set(tools.map(toolGroupAction));
  return actions.size === 1
    ? (actions.values().next().value ?? "other")
    : "mixed";
}

/** Mirrors T3's provider-neutral summary: action and count, never raw arguments. */
export function summarizeToolGroup(tools: readonly ToolRenderItem[]): string {
  if (tools.length === 0) return "Using tools";

  const groups = new Map<ToolGroupAction, ToolRenderItem[]>();
  for (const tool of tools) {
    const action = toolGroupAction(tool);
    const existing = groups.get(action);
    if (existing) existing.push(tool);
    else groups.set(action, [tool]);
  }

  const running = tools.some((tool) => tool.state === "running");
  return sentenceJoin(
    [...groups].map(([action, actionTools]) => {
      const count = actionCount(action, actionTools);
      return running
        ? runningActionLabel(action, count)
        : settledActionLabel(action, count);
    })
  );
}
