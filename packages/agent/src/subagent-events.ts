/**
 * Forwarding a sub-agent's tool calls to the parent's event stream, inside
 * whatever subtask bracket the calling tool opened so they land on that card.
 * Arguments are held from the start event because pi's `tool_execution_end`
 * carries only the result; ids are prefixed because a child session numbers
 * its calls independently of its parent.
 */
import type { AgentEvent, ToolRequest } from "./protocol.js";

/**
 * pi's display name for a tool, matching what the main loop sends; a card
 * labelled `find` when every other transcript says `glob` reads as a
 * different tool.
 */
const DISPLAY_NAMES: Record<string, string> = { find: "glob" };

const toolRequest = (
  prefix: string,
  id: string,
  name: string,
  input: unknown
): ToolRequest => {
  const displayName = DISPLAY_NAMES[name] ?? name;
  const args = (input ?? {}) as Record<string, unknown>;

  // Both keys on purpose: the shared type says `input`, the renderer reads
  // `tool.args`. Same as the main session's toToolRequest.
  return {
    id: `${prefix}-${id}`,
    name: displayName,
    type: displayName,
    input: args,
    args,
  } as ToolRequest;
};

const resultText = (result: unknown): string => {
  if (typeof result === "string") return result;

  if (result != null && typeof result === "object") {
    const content = (result as { content?: unknown }).content;

    if (typeof content === "string") return content;

    if (Array.isArray(content)) {
      return content
        .map((block) =>
          block != null && typeof block === "object" && "text" in block
            ? String((block as { text: unknown }).text)
            : ""
        )
        .join("");
    }
  }

  return "";
};

/**
 * A forwarder, plus `settle()` for anything it never saw finish: an un-ended
 * call stays "executing" and relabels a finished sub-agent "did not finish".
 * Aborting the child session is enough to leave one behind.
 */
export type ChildToolForwarder = ((event: { type?: unknown }) => boolean) & {
  settle: () => void;
};

/**
 * @param prefix  Namespace for child tool call ids, one per sub-agent kind.
 * @returns A handler for child events; true when it forwarded the event.
 */
export const forwardChildToolEvents = (
  prefix: string,
  emit: (event: AgentEvent) => void
): ChildToolForwarder => {
  const inputs = new Map<string, unknown>();
  const names = new Map<string, string>();

  const forward = (event: { type?: unknown }): boolean => {
    if (event.type === "tool_execution_start") {
      const started = event as unknown as {
        toolCallId: string;
        toolName: string;
        args?: unknown;
      };

      inputs.set(started.toolCallId, started.args);
      names.set(started.toolCallId, started.toolName);
      emit({
        type: "tool_execution_start",
        tool: toolRequest(
          prefix,
          started.toolCallId,
          started.toolName,
          started.args
        ),
      });

      return true;
    }

    if (event.type === "tool_execution_end") {
      const ended = event as unknown as {
        toolCallId: string;
        toolName: string;
        result?: unknown;
        isError?: boolean;
      };
      const input = inputs.get(ended.toolCallId) ?? {};

      inputs.delete(ended.toolCallId);
      names.delete(ended.toolCallId);
      emit({
        type: "tool_execution_complete",
        tool: toolRequest(prefix, ended.toolCallId, ended.toolName, input),
        result: {
          id: `${prefix}-${ended.toolCallId}`,
          content: resultText(ended.result),
          rejected: ended.isError === true,
        },
      });

      return true;
    }

    return false;
  };

  forward.settle = (): void => {
    for (const [toolCallId, toolName] of names) {
      emit({
        type: "tool_execution_complete",
        tool: toolRequest(
          prefix,
          toolCallId,
          toolName,
          inputs.get(toolCallId) ?? {}
        ),
        result: {
          id: `${prefix}-${toolCallId}`,
          content: "The sub-agent stopped before this finished.",
          rejected: true,
        },
      });
    }

    inputs.clear();
    names.clear();
  };

  return forward as ChildToolForwarder;
};

/**
 * Every event type a child stream carries, on stderr, behind a flag. A slow
 * provider yields minutes of nothing but `message_update`, which reads exactly
 * like a broken subscription; this is how you tell them apart.
 */
export const traceChildEvent = (
  label: string,
  event: { type?: unknown }
): void => {
  if (process.env.ABACUSAI_BOT_TRACE_SUBAGENT === "1") {
    process.stderr.write(`[${label}-trace] ${String(event.type)}\n`);
  }
};
