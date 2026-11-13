/**
 * Tool search for servers the user added. Every tool definition rides on
 * every request, so a server with hundreds of tools makes each request carry
 * them all, whatever the task. Past a budget, whole servers wait behind
 * `tool_search` instead: the model sees their tool names in its description,
 * searches, and what it finds is switched on under its own name for the rest
 * of the chat.
 *
 * Activated, not proxied: a found tool is the real tool, so the approval
 * gate, routines' rules, the guards and the tool cards all see the name they
 * key on. Loaded tools are only ever added, so the tool list settles after
 * the first few searches and the provider's prompt cache holds again.
 *
 * Built-in servers and the account's connectors are never deferred: their
 * tools carry the app's own guidance and stay as they are.
 */
import { Type } from "typebox";

/** The tool the model calls to find and load deferred tools. */
export const TOOL_SEARCH_NAME = "tool_search";

/**
 * Tokens of definitions from servers the user added that ride on every
 * request. Past it, the largest servers wait behind tool_search.
 */
export const DIRECT_TOOL_TOKEN_BUDGET = 20_000;

/** Results one search loads by default, and at most. */
const DEFAULT_RESULTS = 5;
const MAX_RESULTS = 10;

/** One MCP tool the model could see, and where it comes from. */
export interface SearchableTool {
  name: string;
  description: string;
  schema: Record<string, unknown>;
  /** The server that serves it. */
  server: string;
  /** Only tools from servers the user added are ever deferred. */
  deferrable: boolean;
}

/** Rough tokens a tool's definition adds to every request, four characters each. */
export const definitionTokens = (tool: SearchableTool): number =>
  Math.ceil(
    (tool.name.length +
      tool.description.length +
      JSON.stringify(tool.schema).length) /
      4
  );

/**
 * The tools that wait behind tool_search: whole servers the user added,
 * largest first, until what is left fits DIRECT_TOOL_TOKEN_BUDGET. Whole
 * servers, so a server's tools are found together and a small one the user
 * relies on stays as it is. Empty when everything fits.
 */
export function deferredTools(
  tools: readonly SearchableTool[],
  budget = DIRECT_TOOL_TOKEN_BUDGET
): Set<string> {
  const byServer = new Map<string, { tokens: number; names: string[] }>();
  let total = 0;
  for (const tool of tools) {
    if (!tool.deferrable) continue;
    const tokens = definitionTokens(tool);
    total += tokens;
    const entry = byServer.get(tool.server) ?? { tokens: 0, names: [] };
    entry.tokens += tokens;
    entry.names.push(tool.name);
    byServer.set(tool.server, entry);
  }
  const deferred = new Set<string>();
  const largestFirst = [...byServer.entries()].sort(
    ([a, x], [b, y]) => y.tokens - x.tokens || a.localeCompare(b)
  );
  for (const [, server] of largestFirst) {
    if (total <= budget) break;
    for (const name of server.names) deferred.add(name);
    total -= server.tokens;
  }
  return deferred;
}

/** Lower-case words of two letters or more. */
const wordsOf = (text: string): string[] =>
  text
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((word) => word.length >= 2);

/**
 * The tools a query names, best first. `select:a,b` loads exact names;
 * anything else ranks by the query's words, a word in the tool's name
 * counting above one in its description.
 */
export function searchTools(
  query: string,
  tools: readonly { name: string; description: string }[],
  limit = DEFAULT_RESULTS
): string[] {
  const trimmed = query.trim();
  const cap = Math.max(1, Math.min(MAX_RESULTS, Math.floor(limit)));
  if (trimmed.toLowerCase().startsWith("select:")) {
    const wanted = trimmed
      .slice("select:".length)
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter((name) => name.length > 0);
    return wanted
      .map((name) => tools.find((tool) => tool.name.toLowerCase() === name))
      .filter((tool) => tool != null)
      .map((tool) => tool.name)
      .slice(0, MAX_RESULTS);
  }
  const terms = [...new Set(wordsOf(trimmed))];
  if (terms.length === 0) return [];
  return tools
    .map((tool) => {
      const name = new Set(wordsOf(tool.name));
      const nameText = tool.name.toLowerCase();
      const description = tool.description.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name.has(term)) score += 4;
        else if (nameText.includes(term)) score += 2;
        if (description.includes(term)) score += 1;
      }
      return { name: tool.name, score };
    })
    .filter((hit) => hit.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name))
    .slice(0, cap)
    .map((hit) => hit.name);
}

/**
 * tool_search's description: how to use it, and every deferred tool's name
 * by server, sorted so the text (and the cached prompt) only changes when
 * the servers do.
 */
export function toolSearchDescription(
  deferred: readonly { name: string; server: string }[]
): string {
  const byServer = new Map<string, string[]>();
  for (const tool of deferred) {
    const names = byServer.get(tool.server) ?? [];
    names.push(tool.name);
    byServer.set(tool.server, names);
  }
  const lines = [...byServer.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(
      ([server, names]) =>
        `- ${server} (${names.length}): ${[...names].sort().join(", ")}`
    );
  return (
    "Loads tools from servers the user added that are not loaded yet. The tools listed below " +
    "exist but cannot be called until loaded: search by what you need (for example " +
    '"create issue" or "camera settings"), or load exact names with "select:name1,name2". ' +
    "What a search finds is loaded at once and stays loaded for the rest of the chat: call it " +
    "directly after this. Never tell the user a tool is missing before searching here.\n\n" +
    `Not loaded yet:\n${lines.join("\n")}`
  );
}

/** What tool_search needs from its owner (McpToolSync). */
export interface ToolSearchHost {
  /** The deferred tools, loaded or not. */
  deferred(): readonly SearchableTool[];
  /** Whether a deferred tool is loaded already. */
  isLoaded(name: string): boolean;
  /** Switch these on from the next request. */
  load(names: readonly string[]): void;
}

/** First line of a description, for a result line. */
const summaryOf = (description: string): string => {
  const line = description.split("\n", 1)[0]?.trim() ?? "";
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
};

/** The tool_search tool, as pi registers it. */
export function buildToolSearchTool(host: ToolSearchHost, description: string) {
  return {
    name: TOOL_SEARCH_NAME,
    label: "Tool search",
    description,
    parameters: Type.Object({
      query: Type.String({
        description:
          'Words for what the tool does ("send invoice", "camera pitch"), or "select:name1,name2" ' +
          "for exact names from the list.",
      }),
      max_results: Type.Optional(
        Type.Number({
          description: `How many tools to load, ${DEFAULT_RESULTS} by default and ${MAX_RESULTS} at most.`,
        })
      ),
    }),
    execute: async (
      _toolCallId: string,
      params: { query: string; max_results?: number }
    ) => {
      const deferred = host.deferred();
      const found = searchTools(
        String(params.query ?? ""),
        deferred,
        params.max_results ?? DEFAULT_RESULTS
      );
      if (found.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text:
                `No tool matched "${params.query}". Try other words, or pick exact names from ` +
                'this tool\'s list with "select:".',
            },
          ],
          details: { found: [] as string[] },
        };
      }
      const fresh = found.filter((name) => !host.isLoaded(name));
      host.load(fresh);
      const lines = found.map((name) => {
        const tool = deferred.find((entry) => entry.name === name);
        return `- ${name}: ${summaryOf(tool?.description ?? "")}`;
      });
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Loaded, and callable directly from now on:\n${lines.join("\n")}\n` +
              "Their full parameters are in your tool list.",
          },
        ],
        details: { found },
      };
    },
  };
}
