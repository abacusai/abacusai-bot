/**
 * Secret fields: what a page holds that the model, a screenshot or a chat
 * must never see. One in-page classifier, `__isSecret`, decides for every
 * read path (snapshot, extract, read-backs, the execute lock, the capture
 * mask). A field is secret when it:
 *
 * - is or ever was a password field (a "show password" toggle that makes it
 *   `type=text` does not make it readable): marked on first sight;
 * - names a card or one-time code in any `autocomplete` token
 *   (`billing cc-number`, `section-pay cc-csc`, `one-time-code`), an input,
 *   select or textarea alike;
 * - was filled on the user's behalf (`SECRET_ATTRIBUTE`).
 *
 * `SecretFields` is one tab's state and the one owner of "this page holds
 * secrets": `browser_execute` is refused while the page holds a non-empty
 * secret field (asked of the page each time) or a filled one (until the main
 * frame navigates). `captureMasked` is the one way a screenshot is taken.
 */
import type { BrowserPage } from "./browser-target";

/** Marks a field filled on the user's behalf; set by `markFilledScript`. */
export const SECRET_ATTRIBUTE = "data-abacusai-secret";
/** Marks a field that was a password field when first seen. */
const WAS_PASSWORD_ATTRIBUTE = "data-abacusai-password";

/** What a secret field's value reads as. */
export const HIDDEN_VALUE = "(hidden)";

/**
 * In-page helpers for the scripts that read values: `__isSecret(el)`,
 * `__shown(el, value)` (the value, or `HIDDEN_VALUE` for a secret field) and
 * `__watchPasswords(doc)`, which marks a document's password fields and keeps
 * marking any that a toggle turns to text. Embedding it runs the watch on the
 * top document.
 */
export const SECRET_FIELD_JS = `
  const __SECRET = ${JSON.stringify(SECRET_ATTRIBUTE)};
  const __WAS_PASSWORD = ${JSON.stringify(WAS_PASSWORD_ATTRIBUTE)};
  const __FIELDS = new Set(['INPUT', 'SELECT', 'TEXTAREA']);
  const __isSecret = (el) => {
    try {
      if (!el || el.nodeType !== 1) return false;
      if (el.hasAttribute(__SECRET) || el.hasAttribute(__WAS_PASSWORD)) return true;
      if (!__FIELDS.has(el.tagName)) return false;
      if (el.tagName === 'INPUT' && String(el.type).toLowerCase() === 'password') {
        el.setAttribute(__WAS_PASSWORD, '');
        return true;
      }
      return String(el.getAttribute('autocomplete') || '').toLowerCase().split(/\\s+/)
        .some((token) => token.startsWith('cc-') || token === 'one-time-code');
    } catch { return false; }
  };
  const __shown = (el, value) => (value && __isSecret(el) ? ${JSON.stringify(HIDDEN_VALUE)} : value);
  const __watchPasswords = (doc) => {
    try {
      for (const el of doc.querySelectorAll('input[type=password]')) el.setAttribute(__WAS_PASSWORD, '');
      const key = Symbol.for('abacusai.passwordWatch');
      if (doc[key]) return;
      const observer = new MutationObserver((records) => {
        for (const record of records)
          if (String(record.oldValue).toLowerCase() === 'password') record.target.setAttribute(__WAS_PASSWORD, '');
      });
      observer.observe(doc, { subtree: true, attributes: true, attributeFilter: ['type'], attributeOldValue: true });
      Object.defineProperty(doc, key, { value: observer });
    } catch {}
  };
  __watchPasswords(document);
  const __frameDocument = (el) => {
    if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') return null;
    try { return el.contentDocument; } catch { return null; }
  };
`;

/**
 * True when the page, its open shadow roots or a same-origin frame (all a
 * script can reach) holds a secret field with a value in it.
 */
export const HOLDS_SECRET_VALUE_SCRIPT = `(function() {
  ${SECRET_FIELD_JS}
  const filled = (el) => el.isContentEditable || !__FIELDS.has(el.tagName)
    ? !!el.textContent : String(el.value ?? '') !== '';
  const holds = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (__isSecret(el) && filled(el)) return true;
      if (el.shadowRoot && holds(el.shadowRoot)) return true;
      const inner = __frameDocument(el);
      if (inner) {
        __watchPasswords(inner);
        if (holds(inner)) return true;
      }
    }
    return false;
  };
  return holds(document);
})()`;

const MASK_ATTRIBUTE = "data-abacusai-mask";
const MASKED_ATTRIBUTE = "data-abacusai-masked";
/** Marks a frame owner whose live origin is not the tab's; set before a capture. */
const COVER_ATTRIBUTE = "data-abacusai-cover";

/**
 * Hides every secret field's contents for a capture (a style in each
 * document and open shadow root reached) and puts an opaque box over every
 * frame the page cannot reach into or that `COVER_ATTRIBUTE` names, since a
 * card field in a payment provider's frame is out of reach of the style.
 * Resolves to how many named frames it covered, once painted or after
 * 100 ms, since a hidden view may never paint a frame.
 */
export const MASK_FOR_CAPTURE_SCRIPT = `(function() {
  ${SECRET_FIELD_JS}
  const css = '[' + ${JSON.stringify(MASKED_ATTRIBUTE)} + '] { color: transparent !important;' +
    ' -webkit-text-fill-color: transparent !important; text-shadow: none !important;' +
    ' caret-color: transparent !important; }';
  let named = 0;
  const cover = (doc, frame) => {
    const r = frame.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return;
    const box = doc.createElement('div');
    box.setAttribute(${JSON.stringify(MASK_ATTRIBUTE)}, '');
    box.style.cssText = 'position:fixed;left:' + r.left + 'px;top:' + r.top + 'px;width:' + r.width +
      'px;height:' + r.height + 'px;background:#000;z-index:2147483647;pointer-events:none;';
    doc.documentElement.appendChild(box);
  };
  const mask = (doc, root) => {
    let secret = false;
    for (const el of root.querySelectorAll('*')) {
      if (__isSecret(el)) {
        el.setAttribute(${JSON.stringify(MASKED_ATTRIBUTE)}, '');
        secret = true;
      }
      if (el.shadowRoot) mask(doc, el.shadowRoot);
      if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') continue;
      const inner = __frameDocument(el);
      if (el.hasAttribute(${JSON.stringify(COVER_ATTRIBUTE)})) named += 1;
      else if (inner) {
        __watchPasswords(inner);
        mask(inner, inner);
        continue;
      }
      cover(doc, el);
    }
    if (!secret) return;
    const style = doc.createElement('style');
    style.setAttribute(${JSON.stringify(MASK_ATTRIBUTE)}, '');
    style.textContent = css;
    (root === doc ? doc.head || doc.documentElement : root).appendChild(style);
  };
  mask(document, document);
  return new Promise((resolve) => {
    requestAnimationFrame(() => requestAnimationFrame(() => resolve(named)));
    setTimeout(() => resolve(named), 100);
  });
})()`;

/** Takes away what a capture added, wherever it reached. */
export const UNMASK_SCRIPT = `(function() {
  const clear = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.hasAttribute(${JSON.stringify(MASK_ATTRIBUTE)})) { el.remove(); continue; }
      el.removeAttribute(${JSON.stringify(MASKED_ATTRIBUTE)});
      el.removeAttribute(${JSON.stringify(COVER_ATTRIBUTE)});
      if (el.shadowRoot) clear(el.shadowRoot);
      if (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME') continue;
      let inner = null;
      try { inner = el.contentDocument; } catch { inner = null; }
      if (inner) clear(inner);
    }
  };
  clear(document);
  return true;
})()`;

/**
 * Names a frame owner for covering, unless a frame the page cannot reach
 * already holds it (that frame is covered whole): 'named' or 'inside'.
 */
const NAME_FOR_COVER_FUNCTION = `function() {
  for (let win = this.ownerDocument.defaultView; win && win !== win.top; win = win.parent) {
    try { if (!win.frameElement) return 'inside'; } catch { return 'inside'; }
  }
  this.setAttribute(${JSON.stringify(COVER_ATTRIBUTE)}, '');
  return 'named';
}`;

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

const command = (
  page: BrowserPage,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> => {
  if (!page.debugger.isAttached()) page.debugger.attach("1.3");
  return page.debugger.sendCommand(method, params);
};

const evaluate = async (
  page: BrowserPage,
  expression: string
): Promise<unknown> => {
  const { result, exceptionDetails } = (await command(
    page,
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true }
  )) as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (exceptionDetails != null) throw new Error("the page script failed");
  return result?.value;
};

/** Names the owner of frame `frameId` for covering; whether it is named or inside one covered. */
async function nameForCover(
  page: BrowserPage,
  frameId: string
): Promise<"named" | "inside"> {
  const { backendNodeId } = (await command(page, "DOM.getFrameOwner", {
    frameId,
  })) as { backendNodeId?: number };
  const { object } = (await command(page, "DOM.resolveNode", {
    backendNodeId,
  })) as { object?: { objectId?: string } };
  if (object?.objectId == null) throw new Error("no frame owner");
  const { result } = (await command(page, "Runtime.callFunctionOn", {
    objectId: object.objectId,
    functionDeclaration: NAME_FOR_COVER_FUNCTION,
    returnByValue: true,
  })) as { result?: { value?: unknown } };
  if (result?.value === "named" || result?.value === "inside")
    return result.value;
  throw new Error("the frame owner could not be named");
}

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

/**
 * The one way a screenshot is taken: secret fields hidden, every frame the
 * page cannot reach covered, and each of `foreignFrames` (frames whose live
 * origin is not the tab's, by frame id) covered too; all shown again after.
 * Null, with nothing captured, when any of that could not be done.
 */
export async function captureMasked(
  page: BrowserPage,
  foreignFrames: readonly string[] = []
): Promise<CapturedImage | null> {
  try {
    let named = 0;
    for (const frameId of foreignFrames)
      if ((await nameForCover(page, frameId)) === "named") named += 1;
    const covered = await evaluate(page, MASK_FOR_CAPTURE_SCRIPT);
    if (named > 0 && (typeof covered !== "number" || covered < named))
      return null;
    return await captureUnmasked(page);
  } catch {
    return null;
  } finally {
    await evaluate(page, UNMASK_SCRIPT).catch(() => undefined);
  }
}

const EXECUTE_REFUSAL =
  "This page holds a password, card or one-time code, so scripts cannot run on it. Use browser_snapshot and browser_interact instead.";

/** One tab's secret fields. */
export class SecretFields {
  private filledFields = 0;

  /**
   * Marks the field `selector` names as filled on the user's behalf: from
   * now on its value reads as hidden and the tab is locked against scripts
   * until it navigates. Called by whatever fills it, before the fill.
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

  /**
   * Why `browser_execute` may not run on `page`, or null when it may: the
   * page holds a filled field, or a secret field with a value in it now.
   * Refused too when the page cannot be asked.
   */
  async executeRefusal(page: BrowserPage): Promise<string | null> {
    if (this.filledFields > 0) return EXECUTE_REFUSAL;
    const holds = await evaluate(page, HOLDS_SECRET_VALUE_SCRIPT).catch(
      () => null
    );
    return holds === false ? null : EXECUTE_REFUSAL;
  }
}
