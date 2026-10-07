/**
 * Secret fields: what a page holds that the model, a screenshot or a chat
 * must never see. Two kinds, one rule:
 *
 * - always sensitive, by kind: passwords, card numbers and codes, one-time
 *   codes (`SECRET_FIELD_SELECTOR`);
 * - filled: a field something filled on the user's behalf (a vault fill)
 *   carries `SECRET_ATTRIBUTE`, and the tab is held as holding one until it
 *   navigates.
 *
 * The page scripts that read values (snapshot, extract, read-backs) embed
 * `SECRET_FIELD_JS` and show such a value as `HIDDEN_VALUE`. `SecretFields`
 * is one tab's state: it refuses `browser_execute` while the tab holds a
 * filled field, and `captureMasked` is the one way a screenshot is taken.
 */
import type { BrowserPage } from "./browser-target";

/** Marks a field filled on the user's behalf; set by `markFilledScript`. */
export const SECRET_ATTRIBUTE = "data-abacusai-secret";

/** Fields whose value is never read out, filled or not. */
export const SECRET_FIELD_SELECTOR = [
  "input[type=password]",
  'input[autocomplete^="cc-"]',
  'input[autocomplete~="one-time-code"]',
  `[${SECRET_ATTRIBUTE}]`,
].join(", ");

/** What a secret field's value reads as. */
export const HIDDEN_VALUE = "(hidden)";

/**
 * In-page helpers for the scripts that read values: `__isSecret(el)` and
 * `__shown(el, value)`, the value or `HIDDEN_VALUE` for a secret field.
 */
export const SECRET_FIELD_JS = `
  const __SECRET_FIELDS = ${JSON.stringify(SECRET_FIELD_SELECTOR)};
  const __isSecret = (el) => {
    try { return !!el && el.nodeType === 1 && el.matches(__SECRET_FIELDS); } catch { return false; }
  };
  const __shown = (el, value) => (value && __isSecret(el) ? ${JSON.stringify(HIDDEN_VALUE)} : value);
`;

const MASK_ATTRIBUTE = "data-abacusai-mask";

/**
 * Hides every secret field's contents for a capture: a style in the page and
 * in each same-origin frame, and, with `coverFrames`, an opaque box over each
 * cross-origin frame (a card field in a payment provider's frame is out of
 * reach of the style). Resolves once painted, or after 100 ms, since a hidden
 * view may never paint a frame.
 */
export const maskForCaptureScript = (
  coverFrames: boolean
): string => `(function() {
  const css = ${JSON.stringify(SECRET_FIELD_SELECTOR)} +
    ' { color: transparent !important; -webkit-text-fill-color: transparent !important;' +
    ' text-shadow: none !important; caret-color: transparent !important; }';
  const styled = (doc) => {
    const style = doc.createElement('style');
    style.setAttribute(${JSON.stringify(MASK_ATTRIBUTE)}, '');
    style.textContent = css;
    (doc.head || doc.documentElement).appendChild(style);
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      let inner = null;
      try { inner = frame.contentDocument; } catch { inner = null; }
      if (inner) { styled(inner); continue; }
      if (!${JSON.stringify(coverFrames)}) continue;
      const r = frame.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const box = doc.createElement('div');
      box.setAttribute(${JSON.stringify(MASK_ATTRIBUTE)}, '');
      box.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width +
        'px;height:' + r.height + 'px;background:#000;z-index:2147483647;pointer-events:none;';
      doc.documentElement.appendChild(box);
    }
  };
  styled(document);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)));
    setTimeout(() => resolve(true), 100);
  });
})()`;

/** Takes away what `maskForCaptureScript` added, in every same-origin frame. */
export const unmaskScript = (): string => `(function() {
  const clear = (doc) => {
    doc.querySelectorAll(${JSON.stringify(`[${MASK_ATTRIBUTE}]`)}).forEach((node) => node.remove());
    for (const frame of doc.querySelectorAll('iframe, frame')) {
      let inner = null;
      try { inner = frame.contentDocument; } catch { inner = null; }
      if (inner) clear(inner);
    }
  };
  clear(document);
  return true;
})()`;

/** Marks the field `selector` names as filled; true when it was there. */
export const markFilledScript = (selector: string): string => `(function() {
  const el = document.querySelector(${JSON.stringify(selector)});
  if (!el) return false;
  el.setAttribute(${JSON.stringify(SECRET_ATTRIBUTE)}, '');
  return true;
})()`;

export interface CapturedImage {
  data: string;
  mimeType: "image/jpeg" | "image/png";
}

/** How long any one capture attempt gets. A hidden view can leave a CDP screenshot pending forever. */
const CAPTURE_TIMEOUT_MS = 5_000;

/** The work's result, or null when it fails or outlasts a capture attempt. */
const bounded = <T>(work: () => Promise<T>): Promise<T | null> =>
  Promise.race([
    work().catch(() => null),
    new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), CAPTURE_TIMEOUT_MS).unref?.()
    ),
  ]);

const evaluate = async (
  page: BrowserPage,
  expression: string
): Promise<unknown> => {
  if (!page.debugger.isAttached()) page.debugger.attach("1.3");
  const { result, exceptionDetails } = (await page.debugger.sendCommand(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true }
  )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (exceptionDetails != null) throw new Error("the page script failed");
  return result?.value;
};

/**
 * The page as it is, or null. `capturePage` with `stayHidden` first, since it
 * paints an off-screen view; the debugger's screenshot is the fallback and
 * hangs on a hidden view.
 */
async function captureUnmasked(
  page: BrowserPage
): Promise<CapturedImage | null> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const captured = await bounded(() =>
      page.capturePage(undefined, { stayHidden: true })
    );
    if (captured != null) {
      if (typeof captured.toJPEG === "function") {
        const jpeg = captured.toJPEG(70);
        if (jpeg.length > 0)
          return { data: jpeg.toString("base64"), mimeType: "image/jpeg" };
      }
      const png = captured.toPNG();
      if (png.length > 0)
        return { data: png.toString("base64"), mimeType: "image/png" };
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  const viaDebugger = await bounded(() =>
    page.debugger.sendCommand("Page.captureScreenshot", {
      format: "jpeg",
      quality: 70,
    })
  );
  const data = (viaDebugger as { data?: unknown } | null)?.data;
  return typeof data === "string" && data.length > 0
    ? { data, mimeType: "image/jpeg" }
    : null;
}

/** One tab's secret fields. */
export class SecretFields {
  private filledFields = 0;

  /** The tab holds a field filled on the user's behalf, since its last navigation. */
  get holdsFilled(): boolean {
    return this.filledFields > 0;
  }

  /**
   * Marks the field `selector` names as filled on the user's behalf: from
   * now on its value reads as hidden and the tab is locked against scripts.
   * Called by whatever fills it, before the fill.
   */
  async markFilled(page: BrowserPage, selector: string): Promise<boolean> {
    // Counted first: if the mark fails, the lock still holds.
    this.filledFields += 1;
    return (await evaluate(page, markFilledScript(selector))) === true;
  }

  /** The main frame navigated: the filled fields are gone with the document. */
  navigated(): void {
    this.filledFields = 0;
  }

  /** Why `browser_execute` may not run on this tab, or null when it may. */
  executeRefusal(): string | null {
    return this.holdsFilled
      ? "This page holds a field filled on the user's behalf, so scripts cannot run on it until it navigates. Use browser_snapshot and browser_interact instead."
      : null;
  }

  /**
   * The one way a screenshot is taken: secret fields hidden for the capture
   * and shown again after. Null when they could not be hidden.
   */
  async captureMasked(page: BrowserPage): Promise<CapturedImage | null> {
    try {
      await evaluate(page, maskForCaptureScript(this.holdsFilled));
    } catch {
      return null;
    }
    try {
      return await captureUnmasked(page);
    } finally {
      await evaluate(page, unmaskScript()).catch(() => undefined);
    }
  }
}
