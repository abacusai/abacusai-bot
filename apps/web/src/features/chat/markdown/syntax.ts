import { createHighlighter } from "@tanstack/highlight/core";
import * as languages from "@tanstack/highlight/languages";
import { createTanStackMarkdownHighlighter } from "@tanstack/highlight/markdown";
import type { CodeHighlighter } from "@tanstack/markdown";

const core = createHighlighter({
  languages: Object.values(languages),
  fallbackLanguage: "plaintext",
});

const highlight = createTanStackMarkdownHighlighter(core);
// Streaming appends reparse complete fences too. Reuse their token HTML,
// while bounding both entry count and retained source/output characters.
const cache = new Map<string, string>();
let retained = 0;
const MAX_RETAINED = 512 * 1024;
export const highlightCode: CodeHighlighter = (code, lang, options) => {
  if (code.length > 32 * 1024) return highlight(code, lang, options);
  const key = JSON.stringify([
    code,
    lang,
    options?.highlightLines,
    options?.lineNumbers,
  ]);
  const cached = cache.get(key);
  if (cached != null) {
    cache.delete(key);
    cache.set(key, cached);
    return cached;
  }
  const html = highlight(code, lang, options);
  const size = key.length + html.length;
  if (size > MAX_RETAINED) return html;
  while (cache.size >= 128 || retained + size > MAX_RETAINED) {
    const oldest = cache.entries().next().value;
    if (oldest == null) break;
    retained -= oldest[0].length + oldest[1].length;
    cache.delete(oldest[0]);
  }
  cache.set(key, html);
  retained += size;
  return html;
};
