/**
 * The files a turn produced for the user, derived from its tool calls.
 * `present_deliverable` wins outright when called; otherwise the turn's own
 * file writes are read, filtered to the kinds of file a person asks for so a
 * code turn's twelve `.ts` edits do not show up as twelve deliverables.
 */
import {
  declaredArtifactTargets,
  isDeliverableUrl,
  presentedDeliverables,
} from "#shared/deliverables";

import {
  basename,
  componentOutputPath,
  componentToolBase,
  getFilePath,
} from "./component-tools";
import type { AgentRenderItem, ToolRenderItem } from "./render-utils";

export type TurnDeliverable = {
  /** Absolute or workspace-relative path, or an http(s) URL. */
  path: string;
  /** The agent's own name for it, when it gave one. */
  label?: string;
  isUrl: boolean;
};

/** The file tools whose argument names the file they wrote. */
const FILE_WRITE_TOOLS = new Set([
  "write",
  "edit",
  "write_file",
  "patch",
  "notebook_edit",
  "multi_edit",
]);

/** Tools whose output exists only in the result text's `[artifact]` line. */

const MEDIA_TOOLS = new Set([
  "image_generate",
  "text_to_speech",
  "bfl_flux3_get_result",
]);

/**
 * What counts as a deliverable when the agent did not say: never source code,
 * which the tool row already shows.
 */
const USER_FACING_EXTS = new Set([
  "md",
  "pdf",
  "docx",
  "doc",
  "pptx",
  "xlsx",
  "xls",
  "csv",
  "zip",
  "html",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "mp3",
  "wav",
  "mp4",
]);

/** Working notes the agent keeps for itself, not for the user. */
const SCRATCH_BASENAMES = new Set(["todo.md", "plan.md", "notes.md"]);

const extensionOf = (filePath: string): string => {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

const isUserFacingFile = (filePath: string): boolean =>
  USER_FACING_EXTS.has(extensionOf(filePath)) &&
  !SCRATCH_BASENAMES.has(basename(filePath).toLowerCase());

const settled = (tool: ToolRenderItem): boolean =>
  tool.state === "done" && tool.result?.rejected !== true;

const toolsOf = (items: AgentRenderItem[]): ToolRenderItem[] =>
  items.flatMap((item) => (item.kind === "tool_group" ? item.tools : []));

/** Paths a settled tool wrote, when it is one of the kinds that writes files. */
function writtenPaths(tool: ToolRenderItem): string[] {
  const base = componentToolBase(tool.name);
  if (base != null && base !== "present_deliverable") {
    const target = componentOutputPath(base, tool.input);
    return target == null ? [] : [target];
  }
  if (FILE_WRITE_TOOLS.has(tool.name)) {
    const target = getFilePath(tool.input);
    return target == null ? [] : [target];
  }
  const bare = tool.name.startsWith("agent-tools_")
    ? tool.name.slice("agent-tools_".length)
    : tool.name;
  if (MEDIA_TOOLS.has(bare)) {
    return declaredArtifactTargets(tool.result?.content ?? "");
  }
  return [];
}

/**
 * The turn's deliverables, most important first, each path once. Only settled
 * calls count: a rejected `present_deliverable` presented nothing, and a write
 * still streaming has no file yet.
 */

export function turnDeliverables(items: AgentRenderItem[]): TurnDeliverable[] {
  const tools = toolsOf(items).filter(settled);
  const seen = new Set<string>();
  const out: TurnDeliverable[] = [];
  const add = (path: string, label?: string): void => {
    if (seen.has(path)) return;
    seen.add(path);
    out.push({
      path,
      ...(label != null ? { label } : {}),
      isUrl: isDeliverableUrl(path),
    });
  };

  for (const tool of tools) {
    if (componentToolBase(tool.name) !== "present_deliverable") continue;
    for (const item of presentedDeliverables(tool.input, tool.result?.content))
      add(item.path, item.label);
  }
  if (out.length > 0) return out;

  for (const tool of tools) {
    for (const path of writtenPaths(tool))
      if (isUserFacingFile(path)) add(path);
  }
  return out;
}
