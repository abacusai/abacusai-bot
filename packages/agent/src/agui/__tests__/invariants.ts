/**
 * The stream properties of spec §7.4, checked over any AG-UI event list.
 * Returns every violation found (empty when the stream is well formed).
 */
import { isRunScoped } from "../event.js";
import type { AguiEvent } from "../wire.js";

type Loose = AguiEvent & Record<string, unknown>;

function applyPatch(
  state: Record<string, unknown>,
  ops: Array<{ op: string; path: string; value?: unknown }>
): string | null {
  for (const op of ops) {
    const key = op.path.replace(/^\//, "");

    if (key.includes("/")) return `nested path ${op.path}`;
    if (op.op === "replace" && !(key in state))
      return `replace of absent ${op.path}`;
    if (op.op === "add" || op.op === "replace") state[key] = op.value;
    else return `unsupported op ${op.op}`;
  }

  return null;
}

export function violations(events: readonly AguiEvent[]): string[] {
  const problems: string[] = [];
  let run: string | null = null;
  const messages = new Map<string, "open" | "closed">();
  const tools = new Map<string, { stage: number; results: number }>();
  const children = new Map<string, "open" | "done">();
  let state: Record<string, unknown> | null = null;

  const toolKeyOf = (event: Loose): string =>
    `${(event.subagentRunId as string | undefined) ?? ""}|${event.toolCallId as string}`;

  events.forEach((raw, index) => {
    const event = raw as Loose;
    const at = `#${index} ${event.type}`;

    if (isRunScoped(event) && run == null) {
      problems.push(`${at}: run-scoped event outside a run`);
    }

    switch (event.type) {
      case "RUN_STARTED":
        if (run != null) problems.push(`${at}: started while ${run} is open`);
        run = event.runId as string;
        break;

      case "RUN_FINISHED":
      case "RUN_ERROR": {
        if (run == null) problems.push(`${at}: terminal with no open run`);
        for (const [id, status] of messages) {
          if (status === "open")
            problems.push(`${at}: message ${id} still open`);
        }
        for (const [key, tool] of tools) {
          if (tool.results !== 1)
            problems.push(`${at}: tool ${key} has ${tool.results} results`);
        }
        for (const [id, status] of children) {
          if (status === "open")
            problems.push(`${at}: subagent ${id} still open`);
        }
        messages.clear();
        tools.clear();
        children.clear();
        run = null;
        break;
      }

      case "TEXT_MESSAGE_START":
        if (event.role == null) problems.push(`${at}: no role`);
        if (messages.get(event.messageId as string) === "open") {
          problems.push(`${at}: ${event.messageId as string} started twice`);
        }
        messages.set(event.messageId as string, "open");
        break;

      case "TEXT_MESSAGE_CONTENT":
      case "TEXT_MESSAGE_END":
        if (messages.get(event.messageId as string) !== "open") {
          problems.push(`${at}: ${event.messageId as string} not open`);
        }
        if (event.type === "TEXT_MESSAGE_END")
          messages.set(event.messageId as string, "closed");
        break;

      case "TOOL_CALL_START": {
        const key = toolKeyOf(event);

        if (tools.has(key)) problems.push(`${at}: ${key} started twice`);
        tools.set(key, { stage: 1, results: 0 });
        break;
      }

      case "TOOL_CALL_ARGS":
      case "TOOL_CALL_END":
      case "TOOL_CALL_RESULT": {
        const key = toolKeyOf(event);
        const tool = tools.get(key);
        const stage =
          event.type === "TOOL_CALL_ARGS"
            ? 1
            : event.type === "TOOL_CALL_END"
              ? 2
              : 3;

        if (tool == null) {
          problems.push(`${at}: ${key} not started`);
          break;
        }
        if (stage < tool.stage || (stage === 1 && tool.stage > 1)) {
          problems.push(`${at}: ${key} out of order (stage ${tool.stage})`);
        }
        if (stage === 3 && tool.stage < 2)
          problems.push(`${at}: ${key} result before end`);
        tool.stage = Math.max(tool.stage, stage);
        if (stage === 3) {
          tool.results += 1;
          if (tool.results > 1) problems.push(`${at}: ${key} second result`);
          const content = JSON.parse(event.content as string) as {
            rejected?: boolean;
          };
          const tanstack = (
            event.metadata as { tanstack?: { state?: string } } | undefined
          )?.tanstack;

          if (content.rejected === true && tanstack?.state !== "output-error") {
            problems.push(`${at}: rejected result without output-error`);
          }
        }
        break;
      }

      case "SUBAGENT_STARTED":
        children.set(event.subagentRunId as string, "open");
        break;

      case "SUBAGENT_FINISHED":
      case "SUBAGENT_ERROR": {
        const id = event.subagentRunId as string;

        if (children.get(id) !== "open") problems.push(`${at}: ${id} not open`);
        children.set(id, "done");
        for (const [key, tool] of tools) {
          if (key.startsWith(`${id}|`) && tool.results !== 1) {
            problems.push(`${at}: child call ${key} unresolved at terminal`);
          }
        }
        break;
      }

      case "STATE_SNAPSHOT":
        state = structuredClone(event.snapshot as Record<string, unknown>);
        break;

      case "STATE_DELTA":
        if (state == null) {
          problems.push(`${at}: delta before snapshot`);
          break;
        }
        {
          const error = applyPatch(state, event.delta as never);

          if (error != null) problems.push(`${at}: ${error}`);
        }
        break;

      default:
        break;
    }

    const sub = event.subagentRunId as string | undefined;

    if (
      sub != null &&
      !event.type.startsWith("SUBAGENT_") &&
      children.get(sub) === "done"
    ) {
      problems.push(`${at}: event for ${sub} after its terminal`);
    }
  });

  if (run != null)
    problems.push(`end: run ${run as string} never got a terminal`);

  return problems;
}
