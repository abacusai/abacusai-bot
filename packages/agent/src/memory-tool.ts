/**
 * `memory` — remembering something, from the CLI, which has no MCP server.
 * Name, targets, actions, schema and output are identical to the MCP version
 * in mcp-agent-tools-server.ts so the model meets one tool in both surfaces.
 */
import {
  applyMemoryAction,
  readEntries,
  type MemoryAction,
  type MemoryTarget,
} from "./memory-store.js";

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

export const MEMORY_TOOL_NAME = "memory";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

export function buildMemoryTool(): PiToolDefinitionLike {
  return {
    name: MEMORY_TOOL_NAME,
    label: MEMORY_TOOL_NAME,
    description: [
      "Remember something across sessions.",
      "",
      "Targets:",
      '  "memory" — your own notes: environment facts, project conventions, tool quirks.',
      '  "user"   — what you know about the person: preferences, habits, how they work.',
      "",
      "Actions:",
      '  "add"     — store a new entry (required: content).',
      '  "replace" — swap an entry out (required: match, content).',
      '  "remove"  — forget an entry (required: match).',
      "",
      '"match" is a short fragment that identifies exactly one entry — not the whole text.',
      "Writes land on disk immediately but only reach your system prompt next session.",
      "Keep this curated: store what stays true, not what merely happened.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        target: { type: "string", enum: ["memory", "user"] },
        action: { type: "string", enum: ["add", "replace", "remove"] },
        content: {
          type: "string",
          description: "The entry text, for add and replace.",
        },
        match: {
          type: "string",
          description: "A short unique fragment, for replace and remove.",
        },
      },
      required: ["target", "action"],
    },
    execute: async (_toolCallId, params) => {
      const target = String(params.target ?? "") as MemoryTarget;
      const action = String(params.action ?? "") as MemoryAction;

      if (target !== "memory" && target !== "user")
        return text('target must be "memory" or "user".', true);

      if (action !== "add" && action !== "replace" && action !== "remove") {
        return text('action must be "add", "replace", or "remove".', true);
      }

      const result = await applyMemoryAction(target, action, {
        ...(typeof params.content === "string"
          ? { content: params.content }
          : {}),
        ...(typeof params.match === "string" ? { match: params.match } : {}),
      });

      const entries = result.entries ?? readEntries(target);
      const rendered =
        entries.length > 0
          ? entries.map((entry) => `- ${entry}`).join("\n")
          : "(empty)";

      return result.ok
        ? text(
            `${result.message}\n\n${target === "user" ? "USER PROFILE" : "MEMORY"} now:\n${rendered}`
          )
        : text(result.message, true);
    },
  };
}
