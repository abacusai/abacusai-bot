/**
 * What a served page threw as it loaded: the check `present_deliverable`
 * runs on a local app before calling it done. One check for every browser
 * that runs it (the app's own views, the hosted computer's Chromium), each
 * only supplying the page, so they agree on what counts as broken.
 */
import type { BrowserPage, DidFailLoadListener } from "./browser-target";

/** Where `PAGE_ERROR_COLLECTOR` keeps what it caught. */
const PAGE_ERRORS_KEY = "__abacusPageErrors";
/** Where it keeps the graphics failures the page logged. */
const PAGE_GRAPHICS_KEY = "__abacusPageGraphics";
/** Where it notes that the page asked for a WebGL context. */
const PAGE_WEBGL_KEY = "__abacusPageWebgl";
/** At most this many errors are kept, each cut to `PAGE_ERROR_CHARS`. */
const PAGE_ERRORS_MAX = 10;
const PAGE_ERROR_CHARS = 300;

/**
 * A graphics failure a page only logs: a shader that did not compile or link,
 * an invalid WebGL call, a lost context. three.js and the other engines report
 * these with `console.error`/`console.warn` and draw nothing, so the page
 * throws nothing and looked clean to the error listeners.
 */
const GRAPHICS_FAILURE =
  "shader error|not compiled|failed to compile|compile error|link error|validate_status false|invalid_(?:operation|value|enum|framebuffer_operation)|context (?:was )?lost";

/**
 * Installed before a checked page's own scripts run: what it throws, the
 * promises it leaves rejected, the files of its own that fail to load, and
 * the graphics failures it logs, with whether it asked for WebGL.
 * Another site's failure (an ad, a font host) is not the app's to fix and is
 * left out, as is the opaque "Script error." such a script reports.
 */
export const PAGE_ERROR_COLLECTOR = `(() => {
  const errors = [];
  const graphics = [];
  const webgl = { asked: false };
  Object.defineProperty(window, ${JSON.stringify(PAGE_ERRORS_KEY)}, { value: errors });
  Object.defineProperty(window, ${JSON.stringify(PAGE_GRAPHICS_KEY)}, { value: graphics });
  Object.defineProperty(window, ${JSON.stringify(PAGE_WEBGL_KEY)}, { value: webgl });
  const own = (url) => {
    try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
  };
  const keep = (list, text) => {
    if (list.length < ${PAGE_ERRORS_MAX}) list.push(String(text).slice(0, ${PAGE_ERROR_CHARS}));
  };
  const add = (text) => keep(errors, text);
  const getContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
    if (/webgl/i.test(String(type))) webgl.asked = true;
    return getContext.call(this, type, ...rest);
  };
  const failed = new RegExp(${JSON.stringify(GRAPHICS_FAILURE)}, "i");
  const said = (args) => args.map((arg) => {
    if (arg && typeof arg.message === "string") return arg.message;
    if (typeof arg === "string") return arg;
    try { return JSON.stringify(arg); } catch { return String(arg); }
  }).join(" ");
  // A shader log is the source listing around one ERROR line: keep the
  // headline, the ERROR lines and the marked source line.
  const brief = (text) => text.split("\\n").map((line) => line.replace(/\\u0000/g, "").trim())
    .filter((line, index) => line.length > 0 && (index === 0 || /ERROR:|^>/.test(line))).join(" | ");
  for (const level of ["error", "warn"]) {
    const original = console[level];
    console[level] = function (...args) {
      const text = said(args);
      if (failed.test(text)) keep(graphics, "console." + level + ": " + brief(text));
      return original.apply(this, args);
    };
  }
  addEventListener("webglcontextlost", () => keep(graphics, "the WebGL context was lost"), true);
  addEventListener("error", (event) => {
    const target = event.target;
    if (target != null && target !== window) {
      const url = target.src || target.href;
      if (url && own(url)) add("could not load " + new URL(url, location.href).pathname);
      return;
    }
    if (event.filename ? !own(event.filename) : event.message === "Script error.") return;
    add(event.message || String(event.error));
  }, true);
  addEventListener("unhandledrejection", (event) => {
    const reason = event.reason;
    add("unhandled promise rejection: " + (reason && reason.message ? reason.message : String(reason)));
  });
})()`;

/**
 * What loading a served page found; `errors` empty is a page that ran cleanly.
 * A logged graphics failure counts only on a page that draws (it asked for
 * WebGL, or a canvas covers `PAGE_CHECK_CANVAS_SHARE` of the view), so any
 * other page is checked as it always was.
 */
export type ServedPageCheck =
  | { loaded: true; errors: string[] }
  | { loaded: false; reason: string };

/** How long a checked page gets to load, then to run its start-up code. */
const PAGE_CHECK_LOAD_MS = 15_000;
const PAGE_CHECK_SETTLE_MS = 1_500;
/** A canvas covering this share of the view makes a page one that draws. */
const PAGE_CHECK_CANVAS_SHARE = 0.25;
/**
 * What the check reads: what the page threw, plus the graphics failures it
 * logged when it draws.
 */
export const PAGE_READ = `(() => {
  const caught = window[${JSON.stringify(PAGE_ERRORS_KEY)}];
  if (!Array.isArray(caught)) return { origin: location.origin, caught: null };
  let largest = 0;
  for (const canvas of document.querySelectorAll("canvas")) {
    const box = canvas.getBoundingClientRect();
    const width = Math.min(box.right, innerWidth) - Math.max(box.left, 0);
    const height = Math.min(box.bottom, innerHeight) - Math.max(box.top, 0);
    if (width > 0 && height > 0) largest = Math.max(largest, width * height);
  }
  const drawn = window[${JSON.stringify(PAGE_WEBGL_KEY)}]?.asked === true ||
    largest >= ${PAGE_CHECK_CANVAS_SHARE} * innerWidth * innerHeight;
  const graphics = drawn ? window[${JSON.stringify(PAGE_GRAPHICS_KEY)}] ?? [] : [];
  return { origin: location.origin, caught: [...caught, ...graphics] };
})()`;

/**
 * The whole check, as its one caller allows it: load and settle plus room
 * for the browser to answer, well inside the tool call's own deadline.
 */
export const PAGE_CHECK_BUDGET_MS = 25_000;

/** What the check needs of a page: an Electron view's contents or a hosted tab. */
export type CheckedPage = Pick<
  BrowserPage,
  "debugger" | "loadURL" | "on" | "off"
>;

/** `work`, or a rejection once `signal` aborts; a late failure of `work` is dropped. */
const until = <T>(work: Promise<T>, signal: AbortSignal): Promise<T> => {
  work.catch(() => undefined);
  return new Promise<T>((resolve, reject) => {
    if (signal.aborted)
      return reject(new Error("the page check ran out of time"));
    const stop = (): void =>
      reject(new Error("the page check ran out of time"));
    signal.addEventListener("abort", stop, { once: true });
    work
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", stop));
  });
};

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Loads `url` in `page` with the collector installed before its scripts run,
 * and reads what it caught. Only CDP commands, which answer while a page
 * still loads (`executeJavaScript` waits for loading to stop, forever on a
 * page holding a request open). The page goes to about:blank first, since
 * a view that never navigated leaves debugger commands unanswered, and
 * Page.enable precedes the collector, which is not injected without it.
 * Null when it could not be found out (the page went to another origin):
 * the HTTP answer is all that is known then. Rejects once `signal` aborts.
 */
export async function checkServedPageIn(
  page: CheckedPage,
  url: string,
  signal: AbortSignal
): Promise<ServedPageCheck | null> {
  const origin = new URL(url).origin;
  await until(page.loadURL("about:blank"), signal);
  if (!page.debugger.isAttached()) page.debugger.attach("1.3");
  const cdp = (method: string, params?: Record<string, unknown>) =>
    until(page.debugger.sendCommand(method, params), signal);
  await cdp("Page.enable");
  await cdp("Page.addScriptToEvaluateOnNewDocument", {
    source: PAGE_ERROR_COLLECTOR,
  });
  // Only did-fail-load knows a page did not load: Chromium shows its error
  // page at the very URL that failed.
  let failure: string | null = null;
  const onFailLoad: DidFailLoadListener = (
    _event,
    errorCode,
    errorDescription,
    _failedUrl,
    isMainFrame
  ) => {
    if (isMainFrame && errorCode !== -3)
      failure = `${errorDescription} (${errorCode})`;
  };
  page.on("did-fail-load", onFailLoad);
  try {
    await until(
      Promise.race([
        page.loadURL(url).catch(() => undefined),
        delay(PAGE_CHECK_LOAD_MS),
      ]),
      signal
    );
    if (failure != null) return { loaded: false, reason: failure };
    await until(delay(PAGE_CHECK_SETTLE_MS), signal);
  } finally {
    page.off("did-fail-load", onFailLoad);
  }
  // The origin is read with the errors, so both come from one document.
  const read = (await cdp("Runtime.evaluate", {
    expression: PAGE_READ,
    returnByValue: true,
  })) as { result?: { value?: { origin?: unknown; caught?: unknown } } };
  const value = read.result?.value;
  if (value?.origin !== origin || !Array.isArray(value.caught)) return null;
  return { loaded: true, errors: value.caught.map(String) };
}
