/**
 * `session_search`, as a pi tool. Registered here rather than on the desktop's
 * tool server: reading the history needs nothing from the app, so an agent
 * running without an MCP connection keeps it.
 */
import { Type } from "typebox";

import { renderHits, searchSessions } from "./session-search.js";

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

export const SESSION_SEARCH_TOOL_NAME = "session_search";

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 50;

/** Off with its toolset, like every other tool the panel can withhold. */
export function sessionSearchEnabled(): boolean {
  const excluded = (process.env.ABACUSAI_BOT_EXCLUDED_TOOLS ?? "")
    .split(",")
    .map((name) => name.trim());

  return !excluded.includes(SESSION_SEARCH_TOOL_NAME);
}

const text = (value: string): { type: "text"; text: string } => ({
  type: "text" as const,
  text: value,
});

/**
 * Clamped rather than refused: a bad limit teaches the model nothing it can act
 * on, and asking for 500 sessions just means "lots".
 */
export function resolveLimit(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    return DEFAULT_LIMIT;

  return Math.max(1, Math.min(MAX_LIMIT, Math.trunc(value)));
}

/**
 * @param currentSessionId  Read at call time; the session does not exist yet
 *   when the tool is built, and every query would otherwise match this one.
 */
export function buildSessionSearchTool(
  currentSessionId: () => string | undefined = () => undefined
): PiToolDefinitionLike {
  return {
    name: SESSION_SEARCH_TOOL_NAME,
    label: SESSION_SEARCH_TOOL_NAME,
    description: [
      "Search past conversations, whichever session they happened in. Use it to recall what was",
      "decided or tried before, rather than asking the user to repeat themselves.",
      "",
      "Exact identifiers work best: a function name, a file path, an error string. Matching is",
      "plain substring and case-insensitive, so a paraphrase of what was said will not find it.",
      "",
      "Results are the most recently active sessions first, with a few matching lines each. This",
      "conversation is never among them.",
    ].join("\n"),
    parameters: Type.Object({
      query: Type.String({
        description: "Text to look for. Exact identifiers work best.",
      }),
      limit: Type.Optional(
        Type.Number({
          description: `Maximum sessions to return. Defaults to ${DEFAULT_LIMIT}, capped at ${MAX_LIMIT}.`,
        })
      ),
    }),
    execute: async (_toolCallId, params) => {
      const query = typeof params.query === "string" ? params.query.trim() : "";

      if (query === "") {
        return {
          content: [text("A query is required.")],
          details: {},
          isError: true,
        };
      }

      const hits = searchSessions(
        query,
        resolveLimit(params.limit),
        currentSessionId()
      );

      return {
        content: [text(renderHits(hits, query))],
        details: { query, sessions: hits.map((hit) => hit.sessionId) },
      };
    },
  };
}
