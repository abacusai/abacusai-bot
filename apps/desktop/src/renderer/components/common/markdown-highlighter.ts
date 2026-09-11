import { allLanguages } from "@tanstack/highlight";
import { createHighlighter } from "@tanstack/highlight/core";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";

export const markdownHighlighter = createHighlighter({
  languages: allLanguages,
  fallbackLanguage: "plaintext",
});

export const highlightMarkdownCode =
  createTanStackMarkdownHighlighter(markdownHighlighter);
