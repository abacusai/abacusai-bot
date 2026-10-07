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
 * secrets". It keeps every node ever classified secret by its backend node
 * id, outside the page's reach: a page (or a script run on it) that strips
 * the in-page marks does not make a field readable again, since each read
 * puts them back first. `browser_execute` is refused while the page has any
 * secret field, empty or not, and after a fill until the main frame
 * navigates. `captureMasked` is the one way a screenshot is taken.
 */
import type { FieldFacts } from "../vault/vault-fill";
import type { BrowserPage } from "./browser-target";

/** Marks a field known secret: filled on the user's behalf, or classified so before. */
export const SECRET_ATTRIBUTE = "data-abacusai-secret";
/** Marks a field that was a password field when first seen. */
export const WAS_PASSWORD_ATTRIBUTE = "data-abacusai-password";

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
 * Every secret field the page, its open shadow roots and its same-origin
 * frames hold, as an array of elements (evaluated without `returnByValue`,
 * so each can be named by its backend node id).
 */
export const FIND_SECRET_FIELDS_SCRIPT = `(function() {
  ${SECRET_FIELD_JS}
  const found = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (__isSecret(el)) found.push(el);
      if (el.shadowRoot) walk(el.shadowRoot);
      const inner = __frameDocument(el);
      if (inner) {
        __watchPasswords(inner);
        walk(inner);
      }
    }
  };
  walk(document);
  return found;
})()`;

/** Puts the secret mark back on a node known secret; whether it is in the page now. */
const REASSERT_FUNCTION = `function() {
  this.setAttribute(${JSON.stringify(SECRET_ATTRIBUTE)}, '');
  return this.isConnected;
}`;

/** The remote objects one `SecretFields` pass holds, released together. */
const OBJECT_GROUP = "abacusai-secret-fields";

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

/** The element `selector` names, as a remote object (evaluated without `returnByValue`). */
const elementScript = (selector: string): string =>
  `document.querySelector(${JSON.stringify(selector)})`;

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

const EXECUTE_REFUSAL =
  "This page has a password, card or one-time code field, so scripts cannot run on it. Use browser_snapshot and browser_interact instead.";

/**
 * One tab's secret fields. A tab's cross-origin frame is a document of its
 * own (a `BrowserPage` with a `frameId`): its nodes are known apart from the
 * page's, since a backend node id means nothing in another frame's process.
 */
export class SecretFields {
  private filledFields = 0;
  /**
   * Every node ever classified secret on the current page, by backend node
   * id, per document: "" for the tab's own, else the frame's id.
   */
  private readonly knownBy = new Map<string, Set<number>>();

  private known(page: BrowserPage): Set<number> {
    const scope = page.frameId ?? "";
    let known = this.knownBy.get(scope);
    if (known == null) {
      known = new Set();
      this.knownBy.set(scope, known);
    }
    return known;
  }

  /**
   * Marks the field `selector` names as filled on the user's behalf and
   * remembers its node with the known secret fields: from now on its value
   * reads as hidden, whatever the page does to the mark, and the tab is
   * locked against scripts until it navigates. False when the field could
   * not be marked and remembered; the lock holds either way.
   */
  async markFilled(page: BrowserPage, selector: string): Promise<boolean> {
    // Counted first: if the mark fails, the lock still holds.
    this.filledFields += 1;
    if ((await evaluate(page, markFilledScript(selector))) !== true)
      return false;
    try {
      const { result } = (await command(page, "Runtime.evaluate", {
        expression: elementScript(selector),
        returnByValue: false,
        objectGroup: OBJECT_GROUP,
      })) as { result?: { objectId?: string } };
      if (result?.objectId == null) return false;
      return await this.remember(page, result.objectId);
    } catch {
      return false;
    } finally {
      await command(page, "Runtime.releaseObjectGroup", {
        objectGroup: OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  /**
   * `markFilled` for a node the caller holds as a remote object of `page`
   * (`objectId`), such as the element a value was typed into by mistake.
   */
  async markFilledNode(page: BrowserPage, objectId: string): Promise<boolean> {
    this.filledFields += 1;
    try {
      const { result } = (await command(page, "Runtime.callFunctionOn", {
        objectId,
        functionDeclaration: REASSERT_FUNCTION,
        returnByValue: true,
      })) as { result?: { value?: unknown } };
      if (result?.value == null) return false;
      return await this.remember(page, objectId);
    } catch {
      return false;
    }
  }

  /** Adds the node behind `objectId` to the document's known secret fields. */
  private async remember(
    page: BrowserPage,
    objectId: string
  ): Promise<boolean> {
    const { node } = (await command(page, "DOM.describeNode", {
      objectId,
    })) as { node?: { backendNodeId?: number } };
    if (node?.backendNodeId == null) return false;
    this.known(page).add(node.backendNodeId);
    return true;
  }

  /** Each document's inputs as first seen, by backend node id: what a script did after cannot change them. */
  private readonly firstSeen = new Map<string, Map<number, FieldFacts>>();

  /** Records the inputs of `page`'s document not seen before, as they are now. */
  recordFields(
    page: BrowserPage,
    facts: ReadonlyMap<number, FieldFacts>
  ): void {
    const scope = page.frameId ?? "";
    let seen = this.firstSeen.get(scope);
    if (seen == null) {
      seen = new Map();
      this.firstSeen.set(scope, seen);
    }
    for (const [id, fact] of facts) if (!seen.has(id)) seen.set(id, fact);
  }

  /** The input `backendNodeId` of `page`'s document as first seen; null when it never was. */
  firstFacts(page: BrowserPage, backendNodeId: number): FieldFacts | null {
    return this.firstSeen.get(page.frameId ?? "")?.get(backendNodeId) ?? null;
  }

  /** Documents (by `documentInfo` key) a page script ran on: what they show may be the script's. */
  private readonly scripted = new Set<string>();

  /** Scripts asked for on this tab that have not finished yet. */
  private scriptsArriving = 0;

  /** A script was asked for on this tab; it counts as pending until `scriptSettled`. */
  scriptArrived(): void {
    this.scriptsArriving += 1;
  }

  scriptSettled(): void {
    this.scriptsArriving = Math.max(0, this.scriptsArriving - 1);
  }

  /** Whether a script asked for on this tab has not finished. */
  scriptPending(): boolean {
    return this.scriptsArriving > 0;
  }

  /** A script ran on the document `key`. */
  noteScript(key: string): void {
    this.scripted.add(key);
  }

  /** Whether a script ran on the document `key`. */
  scriptRan(key: string): boolean {
    return this.scripted.has(key);
  }

  /** The main frame navigated: the filled and known fields are gone with the document. */
  navigated(): void {
    this.filledFields = 0;
    this.knownBy.clear();
    this.firstSeen.clear();
  }

  /**
   * Why `browser_execute` may not run on `page`, or null when it may: the
   * page has a secret field (found now, or known from before and still in
   * the page), or holds a filled one. Refused too when the page cannot be
   * asked.
   */
  async executeRefusal(page: BrowserPage): Promise<string | null> {
    if (this.filledFields > 0) return EXECUTE_REFUSAL;
    const present = await this.reassert(page).catch(() => null);
    return present === 0 ? null : EXECUTE_REFUSAL;
  }

  /**
   * Before anything reads the page: records the secret fields it has now and
   * puts the mark back on every one known from before. How many known
   * fields are in the page; rejects when the page could not be asked.
   */
  async reassert(page: BrowserPage): Promise<number> {
    try {
      await this.discover(page);
      let present = 0;
      const known = this.known(page);
      for (const backendNodeId of known) {
        const resolved = (await command(page, "DOM.resolveNode", {
          backendNodeId,
          objectGroup: OBJECT_GROUP,
        }).catch(() => null)) as { object?: { objectId?: string } } | null;
        const objectId = resolved?.object?.objectId;
        // Gone from the renderer: nothing left to read.
        if (objectId == null) {
          known.delete(backendNodeId);
          continue;
        }
        const { result } = (await command(page, "Runtime.callFunctionOn", {
          objectId,
          functionDeclaration: REASSERT_FUNCTION,
          returnByValue: true,
        })) as { result?: { value?: unknown } };
        if (result?.value !== false) present += 1;
      }
      return present;
    } finally {
      await command(page, "Runtime.releaseObjectGroup", {
        objectGroup: OBJECT_GROUP,
      }).catch(() => undefined);
    }
  }

  /** Adds the secret fields the page has now to the known ones. */
  private async discover(page: BrowserPage): Promise<void> {
    const { result, exceptionDetails } = (await command(
      page,
      "Runtime.evaluate",
      {
        expression: FIND_SECRET_FIELDS_SCRIPT,
        returnByValue: false,
        objectGroup: OBJECT_GROUP,
      }
    )) as { result?: { objectId?: string }; exceptionDetails?: unknown };
    if (exceptionDetails != null || result?.objectId == null)
      throw new Error("the page could not be searched");
    const { result: properties } = (await command(
      page,
      "Runtime.getProperties",
      { objectId: result.objectId, ownProperties: true }
    )) as {
      result?: Array<{ name: string; value?: { objectId?: string } }>;
    };
    for (const property of properties ?? []) {
      if (!/^\d+$/.test(property.name)) continue;
      const objectId = property.value?.objectId;
      if (objectId == null) throw new Error("a secret field has no handle");
      const { node } = (await command(page, "DOM.describeNode", {
        objectId,
      })) as { node?: { backendNodeId?: number } };
      if (node?.backendNodeId == null)
        throw new Error("a secret field has no node id");
      this.known(page).add(node.backendNodeId);
    }
  }

  /**
   * The one way a screenshot is taken: every secret field (known ones
   * included) hidden, every frame the page cannot reach covered, and each of
   * `foreignFrames` (frames whose live origin is not the tab's, by frame id)
   * covered too; all shown again after. Null, with nothing captured, when
   * any of that could not be done.
   */
  async captureMasked(
    page: BrowserPage,
    foreignFrames: readonly string[] = []
  ): Promise<CapturedImage | null> {
    try {
      await this.reassert(page);
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
}
