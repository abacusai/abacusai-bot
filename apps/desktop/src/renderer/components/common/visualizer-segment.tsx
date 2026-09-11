import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import { useTheme } from "../../hooks/use-theme";
import { useGlobalContext } from "../../stores/app-global";
import { Skeleton } from "../ui/skeleton";

interface VisualizerSegmentProps {
  code: string;
  dataId?: string;
}

const DEFAULT_HEIGHT = 200;
const MAX_HEIGHT = 4000;

const DARK_THEME_VARS = `
  --color-text-primary: #E5E7EB;
  --color-text-secondary: #9CA3AF;
  --color-text-tertiary: #6B7280;
  --color-text-info: #60A5FA;
  --color-text-success: #34D399;
  --color-text-warning: #FBBF24;
  --color-text-danger: #F87171;
  --color-background-primary: #1A1A1A;
  --color-background-secondary: #262626;
  --color-background-tertiary: #111111;
  --color-border-tertiary: rgba(255,255,255,0.15);
  --color-border-secondary: rgba(255,255,255,0.3);
  --ramp-purple-bg: #3C3489; --ramp-purple-stroke: #AFA9EC;
  --ramp-purple-text: #CECBF6; --ramp-purple-sub: #AFA9EC;
  --ramp-teal-bg: #085041; --ramp-teal-stroke: #5DCAA5;
  --ramp-teal-text: #9FE1CB; --ramp-teal-sub: #5DCAA5;
  --ramp-coral-bg: #712B13; --ramp-coral-stroke: #F0997B;
  --ramp-coral-text: #F5C4B3; --ramp-coral-sub: #F0997B;
  --ramp-gray-bg: #444441; --ramp-gray-stroke: #B4B2A9;
  --ramp-gray-text: #D3D1C7; --ramp-gray-sub: #B4B2A9;
  --ramp-blue-bg: #0C447C; --ramp-blue-stroke: #85B7EB;
  --ramp-blue-text: #B5D4F4; --ramp-blue-sub: #85B7EB;
  --ramp-amber-bg: #633806; --ramp-amber-stroke: #EF9F27;
  --ramp-amber-text: #FAC775; --ramp-amber-sub: #EF9F27;
`;

const LIGHT_THEME_VARS = `
  --color-text-primary: #1F2937;
  --color-text-secondary: #6B7280;
  --color-text-tertiary: #9CA3AF;
  --color-text-info: #2563EB;
  --color-text-success: #059669;
  --color-text-warning: #D97706;
  --color-text-danger: #DC2626;
  --color-background-primary: #FFFFFF;
  --color-background-secondary: #F9FAFB;
  --color-background-tertiary: #F3F4F6;
  --color-border-tertiary: rgba(0,0,0,0.15);
  --color-border-secondary: rgba(0,0,0,0.3);
  --ramp-purple-bg: #EEEDFE; --ramp-purple-stroke: #534AB7;
  --ramp-purple-text: #3C3489; --ramp-purple-sub: #534AB7;
  --ramp-teal-bg: #E1F5EE; --ramp-teal-stroke: #0F6E56;
  --ramp-teal-text: #085041; --ramp-teal-sub: #0F6E56;
  --ramp-coral-bg: #FAECE7; --ramp-coral-stroke: #993C1D;
  --ramp-coral-text: #712B13; --ramp-coral-sub: #993C1D;
  --ramp-gray-bg: #F1EFE8; --ramp-gray-stroke: #5F5E5A;
  --ramp-gray-text: #444441; --ramp-gray-sub: #5F5E5A;
  --ramp-blue-bg: #E6F1FB; --ramp-blue-stroke: #185FA5;
  --ramp-blue-text: #0C447C; --ramp-blue-sub: #185FA5;
  --ramp-amber-bg: #FAEEDA; --ramp-amber-stroke: #854F0B;
  --ramp-amber-text: #633806; --ramp-amber-sub: #854F0B;
`;

const buildStylesheet = (themeVars: string): string => `
:root {
  ${themeVars}
  --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  --font-mono: "SF Mono", Menlo, monospace;
  --border-radius-md: 8px; --border-radius-lg: 12px;
}
* { box-sizing: border-box; margin: 0; font-family: var(--font-sans); }
html, body { overflow: hidden; min-height: 0 !important; height: auto !important; background: transparent !important; }
body { color: var(--color-text-primary); line-height: 1.5; }
button { background: transparent; border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); padding: 6px 14px; font-size: 13px; color: var(--color-text-primary); cursor: pointer; font-family: var(--font-sans); }
button:hover { background: var(--color-background-secondary); }
select { appearance: none; -webkit-appearance: none; background: var(--color-background-secondary); border: 0.5px solid var(--color-border-secondary); border-radius: var(--border-radius-md); padding: 6px 10px; font-size: 13px; color: var(--color-text-primary); font-family: var(--font-sans); }
.t  { font: 400 14px var(--font-sans); fill: var(--color-text-primary); }
.ts { font: 400 12px var(--font-sans); fill: var(--color-text-secondary); }
.th { font: 500 14px var(--font-sans); fill: var(--color-text-primary); }
.box { fill: var(--color-background-secondary); stroke: var(--color-border-tertiary); }
.node { cursor: pointer; } .node:hover { opacity: 0.85; }
.arr { stroke: var(--color-border-secondary); stroke-width: 1.5; fill: none; }
.leader { stroke: var(--color-text-tertiary); stroke-width: 0.5; stroke-dasharray: 3 2; fill: none; }
canvas { max-width: 100%; }
img { max-width: 100%; height: auto; }
`;

// Strip <script> blocks so innerHTML doesn't have to parse them: some payloads
// contain strings like "</em>" inside JS literals that confuse the parser.
const extractScripts = (
  html: string
): { markup: string; scripts: string[] } => {
  const scripts: string[] = [];
  const markup = html.replace(
    /(<script(?:\s[^>]*)?>)([\s\S]*?)(<\/script>)/gi,
    (_m, _open, content: string) => {
      const clean = content.replace(/\u200B/g, "");
      if (clean.trim()) scripts.push(clean);
      return "";
    }
  );
  return { markup, scripts };
};

// The guest eval()s agent-authored chart scripts by design, so block where DATA
// can go (exfil, SSRF to localhost / 169.254.169.254) but keep script-src open
// for chart libraries. Residual: a low-bandwidth <script src> URL channel.
const VISUALIZER_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' 'unsafe-eval' https:",
  "style-src 'unsafe-inline' https:",
  "img-src data: blob:",
  "font-src data: https:",
  "media-src data: blob:",
  "worker-src blob:",
  "connect-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "object-src 'none'",
].join("; ");

// Empty shell loaded into the webview; the host injects markup and scripts via
// `__vz_apply` once layout has settled, because Chart.js with responsive:true
// reads the parent's clientHeight at construction, racing an inline script.

const buildShellDocument = (themeVars: string): string => {
  const stylesheet = buildStylesheet(themeVars);
  const bridge = `<script>
window.onerror = function () { return true; };
// sendPrompt routes a chat-prompt string back to the host. Matches iOS
// VisualizerView.sendPrompt → sendPromptHandler. We trigger a navigation
// to a custom scheme; the host's 'will-navigate' listener preventDefaults
// the navigation and routes the URL based on its scheme. We use
// location.href (not window.open) because Electron 40 removed the
// 'new-window' event on WebviewTag — only 'will-navigate' fires.
window.sendPrompt = function (text) {
  if (typeof text !== 'string' || !text) return;
  try { window.location.href = 'vz-sendprompt:' + encodeURIComponent(text); } catch (e) {}
};
window.__vz_apply = function (markup, scripts) {
  try { document.body.innerHTML = markup || ''; } catch (err) {}
  (scripts || []).forEach(function (content) {
    if (!content) return;
    try { (0, eval)(content); } catch (err) {}
  });
};
// Intercept <a> clicks and hand them to the app rather than the guest. We
// trigger a navigation to a custom 'vz-link:' scheme — Chromium can't resolve
// it so the webview never actually navigates (the chart stays put), but the
// 'will-navigate' event still fires on the host with the URL, which we decode
// and open in the preview pane. Matches iOS VisualizerView's
// WKNavigationDelegate behavior.
document.addEventListener('click', function (e) {
  var t = e.target;
  while (t && t.tagName !== 'A') t = t.parentElement;
  if (!t) return;
  var href = t.getAttribute('href');
  if (!href || href.charAt(0) === '#') return;
  e.preventDefault();
  try { window.location.href = 'vz-link:' + encodeURIComponent(t.href || href); } catch (err) {}
}, true);
</script>`;
  return `<!DOCTYPE html><html style="background:transparent;overflow:hidden"><head><meta charset="utf-8" /><meta http-equiv="Content-Security-Policy" content="${VISUALIZER_CSP}" /><style>${stylesheet}</style>${bridge}</head><body></body></html>`;
};

interface WebviewTag extends HTMLElement {
  executeJavaScript(code: string): Promise<unknown>;
}

const SEND_PROMPT_SCHEME = "vz-sendprompt:";
const LINK_SCHEME = "vz-link:";

// Per-chart-code height cache. The virtualized list remounts a visualizer on
// scroll; without a cache each remount grows from DEFAULT_HEIGHT to the
// measured value and the surrounding messages jump.
const heightCache = new Map<string, number>();

const VisualizerSegmentImpl = ({ code, dataId }: VisualizerSegmentProps) => {
  const { isDark } = useTheme();
  const setPendingPrompt = useGlobalContext((state) => state.setPendingPrompt);
  const setPendingPromptAutoSend = useGlobalContext(
    (state) => state.setPendingPromptAutoSend
  );
  const webviewRef = useRef<WebviewTag | null>(null);
  const cachedHeight = heightCache.get(code);
  const [height, setHeight] = useState<number>(cachedHeight ?? DEFAULT_HEIGHT);
  // A cached height paints correctly at once; skip the shimmer flash.
  const [loaded, setLoaded] = useState<boolean>(cachedHeight !== undefined);
  const codeRef = useRef(code);
  const domReadyRef = useRef(false);
  useEffect(() => {
    codeRef.current = code;
  }, [code]);

  // Empty shell — content is pushed via executeJavaScript after dom-ready.
  const src = useMemo(() => {
    const themeVars = isDark ? DARK_THEME_VARS : LIGHT_THEME_VARS;
    const html = buildShellDocument(themeVars);
    return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
  }, [isDark]);

  // Reset loaded only when the iframe actually remounts (theme swap → new
  // src); a cached height for this exact `code` skips the shimmer.
  useEffect(() => {
    if (heightCache.has(codeRef.current)) return;
    setLoaded(false);
  }, [src]);

  const measureHeight = useCallback(async (wv: WebviewTag) => {
    if (!wv) return;
    try {
      const result = await wv.executeJavaScript(
        "(function(){var b=document.body?document.body.scrollHeight:0;var d=document.documentElement?document.documentElement.scrollHeight:0;return Math.max(b,d);})()"
      );
      const h = typeof result === "number" ? Math.ceil(result) : 0;
      if (h > 0) {
        const target = Math.min(MAX_HEIGHT, h);
        wv.style.height = `${target}px`;
        // Pin the inner iframe inside the webview's shadow DOM: as a replaced
        // element it doesn't reliably stretch to the flex host's cross-axis,
        // so it stays at its initial height and clips the content.
        const innerIframe = (
          wv as unknown as { shadowRoot?: ShadowRoot | null }
        ).shadowRoot?.querySelector("iframe");
        if (innerIframe instanceof HTMLIFrameElement) {
          innerIframe.style.height = `${target}px`;
        }
        heightCache.set(codeRef.current, target);
        setHeight(target);
        setLoaded(true);
      }
    } catch {
      // webview navigating or destroyed
    }
  }, []);

  /**
   * Links inside a chart open in the OS browser, not the pane: a webview with
   * no address bar, tabs or signed-in sessions is the wrong place to land on
   * somebody else's site.
   */
  const openLink = useCallback((url: string): void => {
    void window.api.openExternal(url);
  }, []);

  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv) return;
    let cancelled = false;
    const timeouts: ReturnType<typeof setTimeout>[] = [];

    const onDomReady = async () => {
      if (cancelled) return;
      domReadyRef.current = true;
      const { markup, scripts } = extractScripts(codeRef.current ?? "");
      const payload = `window.__vz_apply(${JSON.stringify(markup)}, ${JSON.stringify(scripts)})`;
      try {
        await wv.executeJavaScript(payload);
      } catch {
        return;
      }
      // Re-measure on a cadence — Chart.js loads from CDN, so the canvas
      // paints and reflows well after we've pushed the content.
      measureHeight(wv);
      timeouts.push(setTimeout(() => !cancelled && measureHeight(wv), 100));
      timeouts.push(setTimeout(() => !cancelled && measureHeight(wv), 400));
      timeouts.push(setTimeout(() => !cancelled && measureHeight(wv), 1000));
      timeouts.push(setTimeout(() => !cancelled && measureHeight(wv), 2500));
    };

    // The guest navigates to vz-sendprompt:<encoded> (chat input) or
    // vz-link:<encoded> (<a> click). Chromium can't resolve either so the chart
    // stays put, but 'will-navigate' (the only hook) still fires with the URL.

    const onWillNavigate = (e: Event) => {
      const url = (e as unknown as { url?: string }).url;
      if (!url || url.startsWith("data:")) return;
      e.preventDefault();
      if (url.startsWith(SEND_PROMPT_SCHEME)) {
        try {
          const text = decodeURIComponent(url.slice(SEND_PROMPT_SCHEME.length));
          if (text) {
            setPendingPromptAutoSend(true);
            setPendingPrompt(text);
          }
        } catch {
          // malformed payload — ignore
        }
        return;
      }
      if (url.startsWith(LINK_SCHEME)) {
        try {
          const real = decodeURIComponent(url.slice(LINK_SCHEME.length));
          if (real) openLink(real);
        } catch {
          // malformed payload — ignore
        }
        return;
      }
      // A bare programmatic navigation (not a vz-link: click) is dropped, not
      // sent to openExternal — that URL would be an exfil channel.
    };

    wv.addEventListener("dom-ready", onDomReady);
    wv.addEventListener("will-navigate", onWillNavigate);
    return () => {
      cancelled = true;
      domReadyRef.current = false;
      timeouts.forEach((t) => clearTimeout(t));
      wv.removeEventListener("dom-ready", onDomReady);
      wv.removeEventListener("will-navigate", onWillNavigate);
    };
  }, [
    src,
    measureHeight,
    openLink,
    setPendingPrompt,
    setPendingPromptAutoSend,
  ]);

  // Code changes after load re-apply without reloading the shell. Gated on
  // dom-ready; before that the dom-ready handler picks up codeRef itself.
  useEffect(() => {
    const wv = webviewRef.current;
    if (!wv || !domReadyRef.current) return;
    const { markup, scripts } = extractScripts(code ?? "");
    wv.executeJavaScript(
      `window.__vz_apply && window.__vz_apply(${JSON.stringify(markup)}, ${JSON.stringify(scripts)})`
    )
      .then(() => measureHeight(wv))
      .catch(() => {
        // webview navigated/destroyed mid-call
      });
  }, [code, measureHeight]);

  const containerStyle = useMemo(() => ({ height }), [height]);
  const webviewStyle = useMemo<React.CSSProperties>(
    () => ({
      width: "100%",
      height: "100%",
      border: 0,
      display: "block",
      opacity: loaded ? 1 : 0,
      transition: "opacity 0.3s ease-in",
    }),
    [loaded]
  );
  return (
    <div
      className="border-foreground/15 bg-secondary my-2 overflow-hidden rounded-lg border p-3"
      data-id={dataId}
    >
      <div className="relative" style={containerStyle}>
        {React.createElement("webview", {
          ref: webviewRef,
          src,
          style: webviewStyle,
          "data-id": dataId ? `${dataId}-webview` : undefined,
        })}
        {!loaded && (
          <Skeleton className="pointer-events-none absolute inset-0" />
        )}
      </div>
    </div>
  );
};

// Memoized so parent re-renders (chat-list updates, scroll state) don't reach
// into the webview; the effect chain only re-runs when `code` changes.

export const VisualizerSegment = React.memo(VisualizerSegmentImpl);
