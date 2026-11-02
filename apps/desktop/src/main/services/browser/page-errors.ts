/**
 * What a served page threw as it loaded: the check `present_deliverable`
 * runs on a local app before calling it done. One check for every browser
 * that runs it (the app's own views, the hosted computer's Chromium), each
 * only supplying the page, so they agree on what counts as broken.
 */
import type { BrowserPage, DidFailLoadListener } from "./browser-target";

/** Where `PAGE_ERROR_COLLECTOR` keeps what it caught. */
const PAGE_ERRORS_KEY = "__abacusPageErrors";
/** At most this many errors are kept, each cut to `PAGE_ERROR_CHARS`. */
const PAGE_ERRORS_MAX = 10;
const PAGE_ERROR_CHARS = 300;

/**
 * Installed before a checked page's own scripts run: what it throws, the
 * promises it leaves rejected, and the files of its own that fail to load.
 * Another site's failure (an ad, a font host) is not the app's to fix and is
 * left out, as is the opaque "Script error." such a script reports.
 */
export const PAGE_ERROR_COLLECTOR = `(() => {
  const errors = [];
  Object.defineProperty(window, ${JSON.stringify(PAGE_ERRORS_KEY)}, { value: errors });
  const own = (url) => {
    try { return new URL(url, location.href).origin === location.origin; } catch { return false; }
  };
  const add = (text) => {
    if (errors.length < ${PAGE_ERRORS_MAX}) errors.push(String(text).slice(0, ${PAGE_ERROR_CHARS}));
  };
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

/** What loading a served page found; `errors` empty is a page that ran cleanly. */
export type ServedPageCheck =
  | { loaded: true; errors: string[] }
  | { loaded: false; reason: string };

/** How long a checked page gets to load, then to run its start-up code. */
const PAGE_CHECK_LOAD_MS = 15_000;
const PAGE_CHECK_SETTLE_MS = 1_500;
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
    expression: `({ origin: location.origin, caught: window[${JSON.stringify(PAGE_ERRORS_KEY)}] ?? null })`,
    returnByValue: true,
  })) as { result?: { value?: { origin?: unknown; caught?: unknown } } };
  const value = read.result?.value;
  if (value?.origin !== origin || !Array.isArray(value.caught)) return null;
  return { loaded: true, errors: value.caught.map(String) };
}
