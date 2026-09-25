/**
 * `memory`: the bot's one tool for its own two-tier store, registered by the
 * bot loop in place of the global memory tool, which bots must never touch.
 * `note` is cheap and append-only, `remember` is core (in every prompt),
 * `forget` prunes core, `search` reaches everything ever noted.
 */
import {
  addCoreEntry,
  appendDailyNote,
  readCoreEntries,
  removeCoreEntry,
  searchMemory,
} from "./bot-memory.js";

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

export const BOT_MEMORY_TOOL_NAME = "memory";

const text = (body: string, isError = false) => ({
  content: [{ type: "text" as const, text: body }],
  details: null,
  ...(isError ? { isError: true } : {}),
});

export function buildBotMemoryTool(dir: string): PiToolDefinitionLike {
  return {
    name: BOT_MEMORY_TOOL_NAME,
    label: BOT_MEMORY_TOOL_NAME,
    description: [
      "Your persistent memory. It outlives this conversation and every restart.",
      "",
      "Actions:",
      '  "note":      jot a working fact into today\'s notes (required: content).',
      "               Cheap and append-only; use it freely as you work.",
      '  "remember":  add a durable fact to core memory (required: content).',
      "               Core memory is in your prompt every turn; keep it curated.",
      '  "forget":    remove a core entry (required: match, a unique fragment).',
      '  "search":    find past notes and memories (required: query).',
      "",
      "Note what happened; remember what stays true.",
    ].join("\n"),
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["note", "remember", "forget", "search"],
        },
        content: {
          type: "string",
          description: "The text to note or remember.",
        },
        match: {
          type: "string",
          description: "A short unique fragment of the entry to forget.",
        },
        query: { type: "string", description: "What to search for." },
      },
      required: ["action"],
    },
    execute: async (_toolCallId, params) => {
      const action = String(params.action ?? "");
      const content = typeof params.content === "string" ? params.content : "";

      if (action === "note") {
        const result = appendDailyNote(dir, content);

        return text(result.message, !result.ok);
      }

      if (action === "remember") {
        const result = addCoreEntry(dir, content);

        if (!result.ok) return text(result.message, true);

        const entries = readCoreEntries(dir);

        return text(
          `${result.message}\n\nCore memory now:\n${entries.map((entry) => `- ${entry}`).join("\n")}`
        );
      }

      if (action === "forget") {
        const result = removeCoreEntry(
          dir,
          typeof params.match === "string" ? params.match : ""
        );

        return text(result.message, !result.ok);
      }

      if (action === "search") {
        const query = typeof params.query === "string" ? params.query : "";
        const hits = searchMemory(dir, query);

        if (hits.length === 0)
          return text(`Nothing in memory matches "${query}".`);

        return text(
          hits.map((hit) => `[${hit.source}] ${hit.line}`).join("\n")
        );
      }

      return text(
        'action must be "note", "remember", "forget", or "search".',
        true
      );
    },
  };
}
