/**
 * Code highlighting (spec 02 §7.4): `@tanstack/highlight` with all 26
 * grammars it ships behind TanStack Markdown's synchronous `highlighter`,
 * plus the `math` branch (display math from the pre-pass). Languages without
 * a grammar fall back to escaped plaintext (F17). The theme CSS targets the
 * markdown renderer's `pre.tm-code`.
 */
import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";
import { createThemeCss } from "@tanstack/highlight/theme";
import { githubDarkTheme as githubDark } from "@tanstack/highlight/themes/github-dark";
import { githubLightTheme as githubLight } from "@tanstack/highlight/themes/github-light";
import type { CodeHighlighter } from "@tanstack/markdown";

import { renderMath } from "./math";

const core = createHighlighter({
  languages: Object.values(languages),
  fallbackLanguage: "plaintext",
});

const markdownHighlight = createTanStackMarkdownHighlighter(core);

/** Plain code, highlighted (the diff and read expanders use it too). */
export const highlightCode = (code: string, lang: string): string =>
  markdownHighlight(code, lang);

export const highlight: CodeHighlighter = (code, lang, options) =>
  lang === "math" ? renderMath(code, true) : markdownHighlight(code, lang, options);

export const CODE_THEME_CSS = createThemeCss({
  light: githubLight,
  dark: githubDark,
  darkSelector: ".dark",
  codeBlockSelector: ".chat-code pre.tm-code",
});

/** A file extension → the grammar name. */
const EXTENSIONS: Record<string, string> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  css: "css",
  html: "html",
  md: "markdown",
  py: "python",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  sql: "sql",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  xml: "xml",
  svelte: "svelte",
  vue: "vue",
  diff: "diff",
  patch: "diff",
  dockerfile: "dockerfile",
};

export const languageForPath = (path: string | undefined): string => {
  if (path == null) return "plaintext";
  const base = path.split(/[\\/]/).at(-1)!.toLowerCase();
  if (base === "dockerfile") return "dockerfile";
  const ext = base.includes(".") ? base.split(".").at(-1)! : "";
  return EXTENSIONS[ext] ?? "plaintext";
};
