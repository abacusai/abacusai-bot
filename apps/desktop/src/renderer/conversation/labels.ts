import { normalizeToolArgs } from "./normalize";
import type { Tool } from "./types";

const IDENTIFIER_LABELS: Readonly<Record<string, string>> = {
  deep_agent: "Deep Agent",
  compute_points: "Compute Points",
};

/** First non-blank string in a string or array of strings. */
function firstStringParam(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() === "" ? undefined : value;
  if (Array.isArray(value)) {
    return value.find(
      (entry): entry is string =>
        typeof entry === "string" && entry.trim() !== ""
    );
  }
  return undefined;
}

/**
 * The one argument to show inline in a tool's header, or "". Keyed off the
 * raw call name rather than `kind` so a tool degraded to `unknown` by a
 * result-less interrupt still shows its argument.
 */
export function getToolHeaderParams(tool: Tool): string {
  const args = normalizeToolArgs(tool.call.args) as Record<string, unknown>;
  switch (tool.call.name) {
    case "bash":
      return firstStringParam(args["command"]) ?? "";
    case "grep":
    case "glob":
      return firstStringParam(args["pattern"]) ?? "";
    case "read":
    case "edit":
    case "write":
      return (
        firstStringParam(args["filePath"]) ??
        firstStringParam(args["path"]) ??
        firstStringParam(args["filepath"]) ??
        ""
      );
    case "web_search_text_only":
      return (
        firstStringParam(args["query"]) ??
        firstStringParam(args["queries"]) ??
        ""
      );
    case "scrape_url_content":
      return (
        firstStringParam(args["url"]) ?? firstStringParam(args["urls"]) ?? ""
      );
    default:
      return "";
  }
}

/** Display form of a wire identifier. */
export function formatIdentifierLabel(identifier: string): string {
  const known = IDENTIFIER_LABELS[identifier];
  if (known !== undefined) return known;

  return identifier
    .replace(/_/g, " ")
    .replace(/([a-z\d])([A-Z])/g, "$1 $2")
    .trim()
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}
