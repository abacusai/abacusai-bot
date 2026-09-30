import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";
const highlight = createTanStackMarkdownHighlighter(
  createHighlighter({
    languages: Object.values(languages),
    fallbackLanguage: "plaintext",
  })
);
const extensions: Record<string, string> = {
  ts: "ts",
  tsx: "tsx",
  js: "js",
  jsx: "jsx",
  py: "python",
  sh: "shell",
  bash: "shell",
  json: "json",
  yml: "yaml",
  yaml: "yaml",
  css: "css",
  html: "html",
  sql: "sql",
  md: "markdown",
  xml: "xml",
  toml: "toml",
};
export const highlightFile = (content: string, path: string): string =>
  highlight(content, extensions[path.split(".").at(-1) ?? ""] ?? "plaintext");
export const toFileUrl = (path: string): string => {
  const encoded = path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => (/^[a-zA-Z]:$/.test(part) ? part : encodeURIComponent(part)))
    .join("/");
  return encoded.startsWith("/") ? `file://${encoded}` : `file:///${encoded}`;
};
