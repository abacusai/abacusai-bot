/**
 * A page's alert, confirm and prompt while the bot acts on it. The browser
 * answered them for the bot with Cancel and said nothing, so a bot saw a
 * button "do nothing" and worked around it (it overrode window.confirm to get
 * an OK). Now they are still answered Cancel, never OK, and the action's
 * result says what the page asked. Outside a bot's action the page's own
 * dialog runs as it always did; in the built-in browser that is a silent
 * Cancel for the user too, so the result never sends them to the pane.
 */
import type { BrowserPage } from "./browser-target";

/** Where the answerer keeps its state in the page. */
const DIALOGS_KEY = "__abacusDialogs";
/** A bot action holds the answerer this long; a dialog after it is the page's own. */
export const DIALOG_ACTING_MS = 10_000;
/** At most this many dialogs are kept between two reads, each cut to `DIALOG_CHARS`. */
const DIALOGS_MAX = 10;
const DIALOG_CHARS = 300;

export type PageDialog = {
  kind: "alert" | "confirm" | "prompt";
  message: string;
};

/**
 * Installed in every document before its own scripts run (and in the one
 * already loaded). While `until` is ahead, a dialog is noted and answered as
 * Cancel would answer it: alert closes, confirm is false, prompt is null.
 */
export const DIALOG_ANSWERER = `(() => {
  if (window[${JSON.stringify(DIALOGS_KEY)}] != null) return;
  const state = { until: 0, seen: [] };
  Object.defineProperty(window, ${JSON.stringify(DIALOGS_KEY)}, { value: state });
  const answered = { alert: undefined, confirm: false, prompt: null };
  for (const kind of ["alert", "confirm", "prompt"]) {
    const own = window[kind];
    window[kind] = function (message, ...rest) {
      if (Date.now() >= state.until) return own.call(window, message, ...rest);
      if (state.seen.length < ${DIALOGS_MAX})
        state.seen.push({ kind, message: String(message ?? "").slice(0, ${DIALOG_CHARS}) });
      return answered[kind];
    };
  }
})()`;

/** Holds the answerer for the next `DIALOG_ACTING_MS`: a bot action starts. */
export const DIALOGS_ACTING = `(() => {
  const state = window[${JSON.stringify(DIALOGS_KEY)}];
  if (state != null) state.until = Date.now() + ${DIALOG_ACTING_MS};
})()`;

/** What the page asked since the last read, and the answerer let go. */
export const DIALOGS_TAKE = `(() => {
  const state = window[${JSON.stringify(DIALOGS_KEY)}];
  if (state == null) return [];
  state.until = 0;
  return state.seen.splice(0);
})()`;

/** The built-in browser cancels a page's own dialogs for the user as well. */
const ELSEWHERE =
  "If they want it confirmed, tell them to do this step on the site in their own browser.";

/** One line per dialog, as the action's result tells it. */
export const dialogLines = (dialogs: readonly PageDialog[]): string[] =>
  dialogs.map((dialog) => {
    const said = JSON.stringify(dialog.message);
    switch (dialog.kind) {
      case "alert":
        return `The page showed an alert: ${said}. It was closed.`;
      case "confirm":
        return `The page asked to confirm: ${said}. The browser answered Cancel; it never answers OK, and the user cannot answer it in the Browser pane either. ${ELSEWHERE}`;
      case "prompt":
        return `The page asked for text: ${said}. The browser answered Cancel and typed nothing; the user cannot answer it in the Browser pane either. ${ELSEWHERE}`;
    }
  });

/** Pages the answerer is installed in. */
const answering = new WeakMap<BrowserPage, true>();

/**
 * The answerer in `page` (once) and held for a bot action. Never throws: a
 * page that cannot take it shows its dialogs as before.
 */
export const answerDialogsWhileActing = async (
  page: BrowserPage,
  cdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>
): Promise<void> => {
  try {
    if (!answering.has(page)) {
      await cdp("Page.enable");
      await cdp("Page.addScriptToEvaluateOnNewDocument", {
        source: DIALOG_ANSWERER,
      });
      await cdp("Runtime.evaluate", { expression: DIALOG_ANSWERER });
      answering.set(page, true);
    }
    await cdp("Runtime.evaluate", { expression: DIALOGS_ACTING });
  } catch {
    // The page shows its own dialogs, as it did before.
  }
};

/** What the page asked during the action, as lines; [] when it asked nothing. */
export const takeDialogs = async (
  cdp: (method: string, params?: Record<string, unknown>) => Promise<unknown>
): Promise<string[]> => {
  try {
    const answer = (await cdp("Runtime.evaluate", {
      expression: DIALOGS_TAKE,
      returnByValue: true,
    })) as { result?: { value?: unknown } } | undefined;
    const value = answer?.result?.value;
    return Array.isArray(value) ? dialogLines(value as PageDialog[]) : [];
  } catch {
    return [];
  }
};
