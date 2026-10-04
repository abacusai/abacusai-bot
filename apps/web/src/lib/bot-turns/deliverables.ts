/**
 * The files a bot turn handed over (spec 03 §11.3a), a port of the old
 * renderer's `components/chat/deliverables.ts` over UIMessages. The scope is
 * the turn: every assistant message between two user messages (pi emits one
 * message per assistant step). `present_deliverable` wins when it accepted
 * anything; otherwise the turn's own user-facing file writes. Only settled
 * calls count.
 */
import type { UIMessage } from "@tanstack/ai-client";

import {
  declaredArtifactTargets,
  isDeliverableUrl,
  presentedDeliverables,
} from "@abacus-ai/contract/deliverables";

import {
  basename,
  componentOutputPath,
  componentToolBase,
  getFilePath,
} from "./component-tools";
import { messageTools, type MessageTool } from "./tool-parts";

export interface TurnDeliverable {
  /** Absolute or workspace-relative path, or an http(s) URL. */
  path: string;
  /** The agent's own name for it, when it gave one. */
  label?: string;
  isUrl: boolean;
}

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

const SCRATCH_BASENAMES = new Set(["todo.md", "plan.md", "notes.md"]);

const extensionOf = (filePath: string): string => {
  const name = basename(filePath);
  const dot = name.lastIndexOf(".");
  return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
};

const isUserFacingFile = (filePath: string): boolean =>
  USER_FACING_EXTS.has(extensionOf(filePath)) &&
  !SCRATCH_BASENAMES.has(basename(filePath).toLowerCase());

function writtenPaths(tool: MessageTool): string[] {
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
  if (MEDIA_TOOLS.has(bare)) return declaredArtifactTargets(tool.text);
  return [];
}

/** The deliverables of one turn's assistant messages, each path once. */
export function turnDeliverables(
  assistantMessages: readonly UIMessage[]
): TurnDeliverable[] {
  const tools = assistantMessages
    .flatMap((message) => messageTools(message))
    .filter((tool) => tool.settled);
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
    for (const item of presentedDeliverables(tool.input, tool.text))
      add(item.path, item.label);
  }
  // A presentation that accepted nothing does not suppress the fallback.
  if (out.length > 0) return out;

  for (const tool of tools)
    for (const path of writtenPaths(tool))
      if (isUserFacingFile(path)) add(path);
  return out;
}
