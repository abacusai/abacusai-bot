/**
 * `todo` — the plan, registered by the agent itself so a session without the
 * desktop's MCP server still has one. Name, actions, schema and output must
 * stay identical to mcp-agent-tools-server.ts: a model that learned the tool
 * one way must not find a different one the other.
 */
import { readTodos, renderTodos, setTodos } from "./todo-store.js";

interface PiToolDefinitionLike {
  name: string;
  label: string;
  description: string;
  parameters: unknown;
  execute: (
    toolCallId: string,
    params: Record<string, unknown>
  ) => Promise<{
    content: Array<{ type: "text"; text: string }>;
    details: unknown;
    isError?: boolean;
  }>;
}

export const TODO_TOOL_NAME = "todo";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

export function buildTodoTool(): PiToolDefinitionLike {
  return {
    name: TODO_TOOL_NAME,
    label: TODO_TOOL_NAME,
    description: [
      "Track a plan for multi-step work.",
      "",
      "Actions:",
      '  "set"  — replace the whole plan (required: todos).',
      '  "list" — read the current plan.',
      "",
      "Write the full list every time rather than editing single items. Exactly one item may be in_progress.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["set", "list"] },
        todos: {
          type: "array",
          description: 'The complete plan, required for "set".',
          items: {
            type: "object",
            properties: {
              content: { type: "string" },
              status: {
                type: "string",
                enum: ["pending", "in_progress", "completed"],
              },
            },
            required: ["content", "status"],
          },
        },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const action = String(params.action ?? "");

      if (action === "list") return text(renderTodos(readTodos()));

      if (action !== "set")
        return text('action must be "set" or "list".', true);

      const result = setTodos(params.todos);

      return result.ok
        ? text(`${result.message}\n\n${renderTodos(result.items)}`)
        : text(result.message, true);
    },
  };
}
