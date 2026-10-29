/**
 * What a served page threw as it loaded: the check `present_deliverable`
 * runs on a local app before calling it done. One collector for every
 * browser that runs the check (the app's own views, the hosted computer's
 * Chromium), so they agree on what counts as broken.
 */

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

/** Evaluated in the page once it has settled: what the collector caught. */
export const PAGE_ERRORS_READ = `window[${JSON.stringify(PAGE_ERRORS_KEY)}] ?? null`;

/** The read's answer as a check; null when the collector never ran there. */
export const pageCheckOf = (caught: unknown): ServedPageCheck | null =>
  Array.isArray(caught) ? { loaded: true, errors: caught.map(String) } : null;
