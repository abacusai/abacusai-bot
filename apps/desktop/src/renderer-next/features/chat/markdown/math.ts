/**
 * temml, loaded lazily (spec 02 §7.3): the first closed math triggers
 * `import("temml")` (default export only, F9); until it resolves, math
 * renders as its escaped TeX and views re-render when it is ready. Output is
 * MathML; `trust: false`, a fresh empty macro table per call, errors
 * rendered (not thrown), results cached in a bounded map.
 */
import { useSyncExternalStore } from "react";

type Temml = typeof import("temml").default;

let temml: Temml | null = null;
let loading: Promise<void> | null = null;
let version = 0;
const listeners = new Set<() => void>();
const cache = new Map<string, string>();
const CACHE_SIZE = 500;

export const escapeHtml = (value: string): string =>
  value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");

export const loadMath = (): Promise<void> => {
  loading ??= import("temml").then((module) => {
    temml = module.default;
    version += 1;
    for (const listener of listeners) listener();
  });
  return loading;
};

/** Re-renders a view once temml has loaded. */
export const useMathVersion = (): number =>
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => version
  );

export const mathReady = (): boolean => temml != null;

export const renderMath = (tex: string, displayMode: boolean): string => {
  if (temml == null) {
    void loadMath();
    return `<span class="chat-math-pending">${escapeHtml(tex)}</span>`;
  }
  const key = `${displayMode ? "D" : "I"}${tex}`;
  const hit = cache.get(key);
  if (hit != null) return hit;
  let html: string;
  try {
    html = temml.renderToString(tex, {
      displayMode,
      throwOnError: false,
      trust: false,
      strict: false,
      maxExpand: 1000,
      // A fresh table per call: a `\def` in one message never leaks.
      macros: {},
    });
  } catch {
    html = `<span class="temml-error">${escapeHtml(tex)}</span>`;
  }
  cache.set(key, html);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value!);
  return html;
};

/** Idle prefetch after the first chat view mounts (§7.3). */
export const prefetchMath = (): void => {
  const idle = (
    globalThis as { requestIdleCallback?: (cb: () => void) => void }
  ).requestIdleCallback;
  if (idle != null) idle(() => void loadMath());
  else setTimeout(() => void loadMath(), 2000);
};
