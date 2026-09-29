import i18n from "../../i18n";
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
  return i18n.t(`toolSummary.settled.${action}`, { count });
}

function runningActionLabel(action: ToolGroupAction, count: number): string {
  return i18n.t(`toolSummary.running.${action}`, { count });
}

function sentenceJoin(labels: string[]): string {
  const normalized = (i18n.language || "en-US").startsWith("en")
    ? labels.map((label, index) =>
        index === 0 ? label : label.charAt(0).toLowerCase() + label.slice(1)
      )
    : labels;
  return new Intl.ListFormat(i18n.language || "en-US", {
    style: "long",
    type: "conjunction",
  }).format(normalized);
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
  if (tools.length === 0) return i18n.t("toolSummary.empty");

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
