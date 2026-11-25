/**
 * A line of Markdown as the words it shows: headings, quotes and list
 * markers, links, code and emphasis go; snake_case, paths and a lone `*`
 * stay. Chat names are plain text wherever they show (sidebar, quit
 * question, notifications), so the name never shows the markup.
 */
const plainLine = (line: string): string =>
  line
    .replace(/^(?:\s*>)+\s*/, "")
    .replace(/^\s*(?:#{1,6}\s+|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)/, "")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/(\*\*|__|~~)(?=\S)(.+?)(?<=\S)\1/g, "$2")
    .replace(/(^|[^\w*])\*(?=\S)([^*]+?)(?<=\S)\*(?![\w*])/g, "$1$2")
    .replace(/(^|[^\w])_(?=\S)([^_]+?)(?<=\S)_(?!\w)/g, "$1$2")
    .replace(/\*\*|~~/g, "")
    .trim();

/** The opening-message title used by the session composer before the renderer rewrite, as plain text. */
export const generateSessionTitle = (message: string): string => {
  const firstLine =
    message
      .split("\n")
      .map(plainLine)
      .find((line) => line.length > 0) ?? "";
  return firstLine.length > 60
    ? `${firstLine.slice(0, 57).trimEnd()}…`
    : firstLine;
};
