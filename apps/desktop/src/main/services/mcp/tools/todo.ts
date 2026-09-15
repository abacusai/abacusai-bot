import type { ToolDefinition } from "./definition";

/**
 * The plan the agent keeps for multi-step work.
 */
export const TODO_TOOLS: ToolDefinition[] = [
  {
    name: "todo",
    toolsets: ["todo"],
    description: [
      "Track a plan for multi-step work.",
      "",
      "Actions:",
      '  "set"  — replace the whole plan (required: todos).',
      '  "list" — read the current plan.',
      "",
      "Write the full list every time rather than editing single items. Exactly one item may be in_progress.",
    ].join("\n"),
    inputSchema: {
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
    run: (host, args) => host.todo(args),
  },
];
