/**
 * Code highlighting (spec 02 §7.4): `@tanstack/highlight` with all 26
 * grammars loaded on the first rendered code block. Subscribers replace
 * escaped plaintext with token HTML once the synchronous highlighter is ready.
 * Languages without a grammar fall back to escaped plaintext (F17).
 * The theme CSS targets the
 * markdown renderer's `pre.tm-code`.
 */
import { createThemeCss } from "@tanstack/highlight/theme";
import { githubDarkTheme as githubDark } from "@tanstack/highlight/themes/github-dark";
import { githubLightTheme as githubLight } from "@tanstack/highlight/themes/github-light";
import type { CodeHighlighter } from "@tanstack/markdown";
import { useSyncExternalStore } from "react";

const listeners = new Set<() => void>();
let loading: Promise<void> | undefined;
const plaintext: CodeHighlighter = (code) => {
  loading ??= import("./syntax")
    .then(({ highlightCode }) => {
      current = highlightCode;
      for (const notify of listeners) notify();
    })
    .catch(() => {
      loading = undefined;
    });
  return code.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
};
let current: CodeHighlighter = plaintext;
const subscribe = (notify: () => void) => {
  listeners.add(notify);
  return () => {
    listeners.delete(notify);
  };
};
const snapshot = () => current;

/** Load grammars only when a rendered block needs code highlighting. */
export const useCodeHighlighter = (): CodeHighlighter =>
  useSyncExternalStore(subscribe, snapshot, snapshot);

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
