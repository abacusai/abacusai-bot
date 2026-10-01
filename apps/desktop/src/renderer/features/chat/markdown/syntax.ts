import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";

const core = createHighlighter({
  languages: Object.values(languages),
  fallbackLanguage: "plaintext",
});

export const highlightCode = createTanStackMarkdownHighlighter(core);
