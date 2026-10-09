/**
 * `delegate_task`, as a pi tool. Kept apart from `delegation.ts` so the schema
 * and result phrasing stay separate from the mechanics of the sub-session.
 */
import { Type } from "typebox";

import {
  resolveTaskRoot,
  runDelegatedTask,
  type DelegationContext,
} from "./delegation.js";
import { scopeEmit, tagEvent } from "./event-meta.js";
import type { AgentEvent } from "./protocol.js";

/**
 * Whether this session gets `delegate_task`. Off when the desktop switched the
 * toolset off, and always off for a bot (ABACUSAI_BOT_BOT_DIR marks one). A
 * delegate starts blank (no notes, no working folder, none of what the bot
 * already fetched), so the bot has to re-describe its own state to it and
 * gets that wrong, and the delegate's report lands in the user's chat as if
 * the bot had said it. A bot's work is sequential; it does it itself.
 */
export function delegationEnabled(): boolean {
  if ((process.env.ABACUSAI_BOT_BOT_DIR ?? "").length > 0) return false;

  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes("delegate_task");
}

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>,
    signal?: AbortSignal
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

/**
 * @param emit  Publishes agent events; the run is bracketed in
 *              `subtask_start`/`subtask_end` so the Agents pane shows it live.
 */
export function buildDelegateTool(
  context: DelegationContext,
  emit: (event: AgentEvent) => void
): PiToolDefinitionLike {
  let counter = 0;

  return {
    name: "delegate_task",
    label: "delegate_task",
    description: [
      "Hand one self-contained investigation to a sub-agent and get back only its conclusion.",
      "",
      "Worth it when answering would mean reading across many files and you only need the",
      "answer, not the search: the sub-agent spends the tool calls, you keep the finding.",
      "",
      "The sub-agent cannot ask questions or delegate further, so give it everything it needs",
      "in the task description. It sees none of this conversation.",
      "",
      "It works in one folder, `root` (your working folder unless you name another), plus any",
      "path the task names; the rest of the user's home folder is refused. Point `root` at the",
      "folder the task is about, and make sure what it needs is there: a partial clone missing a",
      "package means the sub-agent reports it missing.",
      "",
      "Not worth it for a single-file lookup you could do in one read.",
    ].join("\n"),
    parameters: Type.Object({
      task: Type.String({
        description:
          "The complete, self-contained task. State what to find and what to report back, as if to someone who has not read this conversation.",
      }),
      root: Type.Optional(
        Type.String({
          description:
            "The folder the task is about, e.g. the repo you cloned: absolute, ~/, or relative to your working folder. Defaults to your working folder.",
        })
      ),
    }),
    execute: async (toolCallId, params, signal) => {
      // Stop can land before the tool starts; a sub-session would outlive the
      // turn.
      if (signal?.aborted) {
        return {
          content: [{ type: "text" as const, text: "Stopped." }],
          details: { stoppedBy: "aborted" },
          isError: true,
        };
      }

      const task = typeof params.task === "string" ? params.task.trim() : "";

      if (task.length === 0) {
        return {
          content: [
            { type: "text" as const, text: "A task description is required." },
          ],
          details: {},
          isError: true,
        };
      }

      const scope = resolveTaskRoot(
        typeof params.root === "string" ? params.root : undefined,
        context.cwd
      );

      if ("error" in scope) {
        return {
          content: [{ type: "text" as const, text: scope.error }],
          details: {},
          isError: true,
        };
      }

      // Bracketed even on failure, or the card spins in the Agents pane
      // forever.
      const subtaskId = `delegate-${Date.now()}-${++counter}`;
      emit(
        tagEvent(
          {
            type: "subtask_start",
            id: subtaskId,
            description: task.length > 120 ? `${task.slice(0, 117)}…` : task,
            kind: "delegate",
          },
          { parentToolCallId: toolCallId }
        )
      );
      // Everything the sub-agent does is tagged as its own (AG-UI only).
      const childEmit = scopeEmit(emit, subtaskId);

      let result;
      // Failed until proven otherwise: a throw reaches `finally` without
      // setting it.
      let status: "completed" | "failed" = "failed";
      try {
        result = await runDelegatedTask(
          context,
          task,
          childEmit,
          signal,
          scope.root
        );
        status =
          result.stoppedBy === "error" ||
          result.stoppedBy === "provider-error" ||
          result.stoppedBy === "aborted"
            ? "failed"
            : "completed";

        // Text inside the bracket lands on the sub-agent's card, not the
        // transcript.
        if (result.text.trim().length > 0)
          childEmit({ type: "text_delta", content: result.text });
      } finally {
        emit({ type: "subtask_end", id: subtaskId, status });
      }

      const failed =
        result.stoppedBy === "error" ||
        result.stoppedBy === "provider-error" ||
        result.stoppedBy === "aborted";

      return {
        content: [{ type: "text" as const, text: result.text }],
        details: { turns: result.turns, stoppedBy: result.stoppedBy },
        isError: failed,
      };
    },
  };
}
