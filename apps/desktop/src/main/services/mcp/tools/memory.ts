import type { ToolDefinition } from "./definition";

/**
 * Notes that outlive the session.
 */
export const MEMORY_TOOLS: ToolDefinition[] = [
  {
    name: "memory",
    toolsets: ["memory"],
    description: [
      "Remember something across sessions.",
      "",
      "Targets:",
      '  "memory": your own notes (environment facts, project conventions, tool quirks).',
      '  "user":   what you know about the person (preferences, habits, how they work).',
      "",
      "Actions:",
      '  "add":     store a new entry (required: content).',
      '  "replace": swap an entry out (required: match, content).',
      '  "remove":  forget an entry (required: match).',
      "",
      '"match" is a short fragment that identifies exactly one entry, not the whole text.',
      "Writes land on disk immediately but only reach your system prompt next session.",
      "Keep this curated: store what stays true, not what merely happened.",
    ].join("\n"),
    inputSchema: {
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
    run: (host, args) => host.memory(args),
  },
];
