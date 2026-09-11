/**
 * Adapts the canonical `Tool` onto the `ToolRenderItem` shape the chat tool
 * UI renders. A field re-labelling, not a transformation, so
 * `components/chat/tool-group.tsx` needs no changes.
 */
import type { ToolDisplayData, ToolResult } from "#shared/agent-types";

import type { Segment, Tool, ToolSegment } from ".";
import { getToolLifecycleStatus } from ".";
import type {
  ToolRenderItem,
  ToolRenderState,
} from "../components/chat/render-utils";

function renderState(tool: Tool): ToolRenderState {
  switch (getToolLifecycleStatus(tool)) {
    case "running":
      return "running";
    case "error":
    case "rejected":
    case "interrupted":
      return "error";
    default:
      return "done";
  }
}

function displayDataFor(tool: Tool): ToolDisplayData | undefined {
  const data = tool.result?.data;
  if (data == null) return undefined;

  if (data.type === "file_mutation") {
    return {
      ...(data.originalContent != null
        ? { originalContent: data.originalContent }
        : {}),
      ...(data.finalContent != null
        ? { finalContent: data.finalContent, newContent: data.finalContent }
        : {}),
      ...(data.isNewFile != null ? { isNewFile: data.isNewFile } : {}),
      ...(data.additions != null ? { additions: data.additions } : {}),
      ...(data.deletions != null ? { deletions: data.deletions } : {}),
    };
  }
  if (data.type === "bash") {
    return { streamingOutput: data.output };
  }
  if (data.type === "read") {
    return { lineCount: data.lineCount };
  }
  return undefined;
}

/**
 * Display content for a settled tool. `result.output` is the LLM-facing
 * rendering (a summary line for a read, not the file); prefer the typed
 * `result.data` and fall back to `output` only without it.
 */
function displayContentFor(result: NonNullable<Tool["result"]>): string {
  const data = result.data;
  if (data != null) {
    if (data.type === "read") return data.content;
    if (data.type === "bash") return data.output;
    if (data.type === "mcp") return data.content;
    if (data.type === "generic") return data.output;
    if (data.type === "file_mutation") {
      return data.finalContent ?? data.diff ?? result.output ?? "";
    }
  }
  return result.output ?? "";
}

function resultFor(tool: Tool): ToolResult | undefined {
  const result = tool.result;
  if (result == null) return undefined;
  return {
    id: result.toolCallId,
    content: result.error ?? displayContentFor(result),
    ...(result.rejection != null ? { rejected: true } : {}),
  };
}

/**
 * Live output still streaming into an unfinished tool. For a file write this
 * is `fileTail`, not `fileWriteBuffer`: re-rendering the whole file on every
 * chunk slows as it grows and reads as a stall.
 */
function liveOutputFor(segment: ToolSegment): string | undefined {
  if (segment.type === "terminal_command")
    return segment.cmdOutput || undefined;
  if (segment.type === "file_write") {
    if (segment.fileWriteDone) return undefined;
    const tail = segment.fileTail;
    return tail != null && tail.length > 0 ? tail.join("\n") : undefined;
  }
  return undefined;
}

export function toToolRenderItem(segment: ToolSegment): ToolRenderItem {
  const tool = segment.tool;
  const liveOutput = liveOutputFor(segment);
  const displayData = displayDataFor(tool);
  const result = resultFor(tool);
  return {
    id: tool.call.id,
    name: tool.call.name,
    input: tool.call.args,
    ...(result != null ? { result } : {}),
    state: renderState(tool),
    ...(liveOutput != null ? { liveOutput } : {}),
    ...(displayData != null ? { displayData } : {}),
    // A silent command stays `pending` for its whole run, but its arguments
    // are already complete, so render the real row; only a call with no
    // arguments has nothing to label.
    streamingArgs:
      segment.type === "pending" && Object.keys(tool.call.args).length === 0,
  };
}

const TOOL_SEGMENT_TYPES = new Set<Segment["type"]>([
  "tool_call",
  "terminal_command",
  "file_write",
  "file_read",
  "pending",
]);

export function isToolSegment(segment: Segment): segment is ToolSegment {
  return TOOL_SEGMENT_TYPES.has(segment.type);
}
