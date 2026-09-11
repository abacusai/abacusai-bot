/**
 * The page snapshot: the script that runs in the page, and the pure functions
 * that turn what it returns into what the agent reads. Kept out of
 * `mcp-browser-server.ts`, which imports `electron`, so it can be tested.
 */

// Runs in page context via Runtime.evaluate: @eN refs for interactive and
// cursor-interactive elements, content roles, landmarks, and CSS selectors.
export const SNAPSHOT_BUILD_JS = `(function() {
  const INTERACTIVE_TAGS = new Set([
    'A','BUTTON','INPUT','TEXTAREA','SELECT','DETAILS','SUMMARY',
  ]);
  const INTERACTIVE_ROLES = new Set([
    'button','link','textbox','checkbox','radio','combobox','listbox',
    'menuitem','menuitemcheckbox','menuitemradio','tab','switch','slider',
    'spinbutton','searchbox','option','treeitem',
  ]);
  const CONTENT_ROLES = new Set([
    'heading','cell','gridcell','columnheader','rowheader','listitem',
    'article','region',
  ]);
  const LANDMARK_TAGS = new Set([
    'NAV','MAIN','HEADER','FOOTER','ASIDE','SECTION','FORM','ARTICLE',
  ]);
  const HEADING_TAGS = new Set(['H1','H2','H3','H4','H5','H6']);
  // How far below <body> the walk goes.
  //
  // This was 12, which is not a deep page — it is an ordinary one. A button
  // inside a modern app's shell (root > provider > layout > main > section >
  // card > row > ...) sits well past it, and everything beyond was dropped
  // silently: the snapshot came back with a handful of refs, or none, and the
  // tool blamed the page. Sixty clears real markup with room to spare, and the
  // walk was already visiting every element it did not prune.
  const MAX_DEPTH = 60;
  // Refs are keyed by selector and kept on the window, so @e12 stays @e12
  // across snapshots for as long as the element exists. Renumbering on every
  // snapshot made a stale ref the most common failure of the whole toolset.
  const refStore = window.__abacusBotRefs || (window.__abacusBotRefs = { bySelector: {}, next: 1 });
  const refOf = (selector) => {
    let ref = refStore.bySelector[selector];
    if (!ref) {
      ref = '@e' + refStore.next++;
      refStore.bySelector[selector] = ref;
    }
    return ref;
  };
  const refByElement = new Map();
  const vpW = window.innerWidth;
  const vpH = window.innerHeight;

  // Three states, not two. 'gone' takes the subtree with it; 'invisible' is an
  // element a user cannot see or click but whose children may still be both —
  // visibility, unlike display, is inherited and can be turned back on.
  //
  // visibility:hidden used to slip through entirely: such an element keeps its
  // layout box, so it has an offsetParent and a non-zero rect, and the old
  // check only looked at the computed style when offsetParent was null. Hidden
  // menus and closed dropdowns therefore came back as refs the agent could not
  // click.
  function visibilityOf(el) {
    const s = getComputedStyle(el);
    if (s.display === 'none') return 'gone';
    if (!el.offsetParent && el.tagName !== 'BODY' && el.tagName !== 'HTML'
        && s.position !== 'fixed' && s.position !== 'sticky') return 'gone';
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return 'gone';
    if (s.visibility === 'hidden' || s.visibility === 'collapse') return 'invisible';
    return 'visible';
  }

  function isInViewport(el) {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < vpH && r.right > 0 && r.left < vpW;
  }

  // Detect cursor-interactive elements that aren't natively interactive
  // (agent-browser pattern: catch custom <div> buttons with cursor:pointer)
  function isCursorInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return false;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return false;
    if (el.onclick || el.getAttribute('onclick')) return true;
    if (el.tabIndex >= 0) return true;
    if (el.contentEditable === 'true') return true;
    try {
      const s = getComputedStyle(el);
      if (s.cursor === 'pointer') {
        const p = el.parentElement;
        if (!p || getComputedStyle(p).cursor !== 'pointer') return true;
      }
    } catch { /* getComputedStyle can throw on a detached element — not clickable */ }
    return false;
  }

  function isInteractive(el) {
    if (INTERACTIVE_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    return isCursorInteractive(el);
  }

  function isContentRole(el) {
    if (HEADING_TAGS.has(el.tagName)) return true;
    const role = el.getAttribute('role');
    if (role && CONTENT_ROLES.has(role)) return true;
    if (el.tagName === 'LI' || el.tagName === 'TD' || el.tagName === 'TH') return true;
    if (el.tagName === 'IMG' && (el.alt || el.getAttribute('aria-label'))) return true;
    return false;
  }

  // Every label goes through this on the way out.
  //
  // A name is rendered onto one line of the tree, and the tree's structure is
  // its indentation — so a label with a newline in it (a two-line button, a
  // <select> whose text is its options one per line) split the node across
  // lines and the second half read as a node of its own at the top level.
  function clean(text) {
    // The escape below is doubled on purpose: this whole script lives inside a
    // TypeScript template literal, which swallows an escape it does not know,
    // so a single-backslash whitespace class arrives as the bare letter s. It
    // did, and every "s" in every label was replaced with a space.
    return String(text ?? '').replace(/\\s+/g, ' ').trim();
  }

  function cap(text, limit) {
    const value = clean(text);
    return value.length <= limit ? value : value.slice(0, limit - 3) + '...';
  }

  function getLabel(el) {
    const aria = el.getAttribute('aria-label');
    if (aria) return cap(aria, 80);
    if (el.tagName === 'IMG') return cap(el.alt || '', 80);
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.placeholder) return '';
      const id = el.id || el.getAttribute('name');
      if (id) {
        const lbl = document.querySelector('label[for="' + CSS.escape(id) + '"]');
        if (lbl) return cap(lbl.textContent, 80);
      }
      // A label wrapped around the field instead of pointing at it. The branch
      // below handles the label element, but a <label> is not interactive so it
      // never gets a ref — the checkbox inside does, and it was coming back
      // with no name at all: "[input] type=checkbox [unchecked]", with nothing
      // to say what was being agreed to.
      const wrapping = el.closest('label');
      if (wrapping) {
        const text = clean(wrapping.textContent);
        if (text) return cap(text, 80);
      }
    }
    // Labels wrapping hidden inputs (agent-browser pattern)
    if (el.tagName === 'LABEL') {
      const inp = el.querySelector('input[type="checkbox"],input[type="radio"]');
      if (inp) {
        const txt = Array.from(el.childNodes)
          .filter(n => n.nodeType === 3)
          .map(n => clean(n.textContent))
          .filter(Boolean).join(' ');
        return cap(txt, 80);
      }
    }
    const directText = Array.from(el.childNodes)
      .filter(n => n.nodeType === 3)
      .map(n => clean(n.textContent))
      .filter(Boolean)
      .join(' ');
    if (directText) return cap(directText, 80);
    if (el.title) return cap(el.title, 80);
    return cap(el.innerText || '', 60);
  }

  // Every candidate is checked before it is handed out, and the order is
  // "most likely to survive a re-render" first.
  //
  // The id/data-id/data-testid/name forms used to return early, unverified —
  // only the built path was checked. That is backwards: those are exactly the
  // attributes that repeat. A list carrying data-testid="row-delete" on every
  // row gave every row the same selector, so a click on the fortieth resolved
  // to the first. Duplicate ids are invalid HTML and entirely ordinary in
  // component-built pages, with the same result.
  function resolvesTo(selector, el) {
    try {
      return document.querySelector(selector) === el;
    } catch {
      // An attribute value that will not survive being put in a selector.
      return false;
    }
  }

  // Escaped with split/join rather than a regex: this string passes through a
  // TypeScript template literal on its way into the page, and a character
  // class holding a backslash does not survive the trip legibly — it arrived
  // as an unterminated class and took every snapshot with it.
  function attributeSelector(attribute, value) {
    const escaped = value.split('\\\\').join('\\\\\\\\').split('"').join('\\\\"');
    return '[' + attribute + '="' + escaped + '"]';
  }

  function buildSelector(el) {
    const candidates = [];

    if (el.id) candidates.push('#' + CSS.escape(el.id));
    const did = el.getAttribute('data-id');
    if (did) candidates.push(attributeSelector('data-id', did));
    const tid = el.getAttribute('data-testid');
    if (tid) candidates.push(attributeSelector('data-testid', tid));
    const name = el.getAttribute('name');
    if (name && (el.tagName === 'INPUT' || el.tagName === 'SELECT' || el.tagName === 'TEXTAREA')) {
      candidates.push(el.tagName.toLowerCase() + attributeSelector('name', name));
    }

    // A short path from the nearest handle, which stays readable and survives
    // changes further up the page.
    const segs = [];
    let cur = el;
    for (let i = 0; i < 8 && cur && cur !== document.body; i++) {
      let s = cur.tagName.toLowerCase();
      if (cur.id) { segs.unshift('#' + CSS.escape(cur.id)); break; }
      const d = cur.getAttribute('data-id');
      if (d) { segs.unshift(attributeSelector('data-id', d)); break; }
      const p = cur.parentElement;
      if (p) {
        const sibs = Array.from(p.children).filter(c => c.tagName === cur.tagName);
        if (sibs.length > 1) s += ':nth-of-type(' + (sibs.indexOf(cur) + 1) + ')';
      }
      segs.unshift(s);
      cur = p;
    }
    if (segs.length > 0) candidates.push(segs.join(' > '));

    // The whole way up, as the last resort. The cap here was 12 ancestors,
    // which a React page passes without trying: the path came out truncated,
    // so it was relative and matched the first element that happened to fit
    // ANYWHERE in the document.
    const path = [];
    let c = el;
    for (let i = 0; i < 64 && c && c !== document.documentElement; i++) {
      let tag = c.tagName.toLowerCase();
      const pp = c.parentElement;
      if (pp) {
        const sibs = Array.from(pp.children).filter(x => x.tagName === c.tagName);
        if (sibs.length > 1) tag += ':nth-of-type(' + (sibs.indexOf(c) + 1) + ')';
      }
      path.unshift(tag);
      c = pp;
    }
    if (path.length > 0) candidates.push(path.join(' > '));

    for (const candidate of candidates) {
      if (resolvesTo(candidate, el)) return candidate;
    }

    // Nothing identifies it — inside a shadow root, or nested past the cap.
    // Returning a selector anyway is what put a wrong-element ref in the map,
    // so the caller drops the ref instead and the element stays in the tree as
    // context the agent can read but not aim at.
    return null;
  }

  function walk(el, depth) {
    const visibility = visibilityOf(el);
    if (depth > MAX_DEPTH || visibility === 'gone') return null;
    const interactive = isInteractive(el);
    const content = isContentRole(el);
    const isLandmark = LANDMARK_TAGS.has(el.tagName);
    const getsRef = (interactive || content) && visibility === 'visible';

    let ref = null;
    let selector = null;
    if (getsRef) {
      selector = buildSelector(el);
      if (selector) {
        ref = refOf(selector);
        refByElement.set(el, ref);
      }
    }

    const childNodes = [];
    for (const child of el.children) {
      const n = walk(child, depth + 1);
      if (n) childNodes.push(n);
    }
    if (!getsRef && !isLandmark && childNodes.length === 0) return null;
    if (!getsRef && !isLandmark && childNodes.length === 1) return childNodes[0];

    const node = {};
    if (ref) {
      node.ref = ref;
      node.selector = selector;
      if (!isInViewport(el)) node.offscreen = true;
      if (!interactive) node.readonly = true;
    } else if (getsRef) {
      // Reachable to read, not to click. Said out loud so the agent stops
      // hunting for a ref that is never coming.
      node.unreachable = true;
    }
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    if (HEADING_TAGS.has(el.tagName)) node.tag = tag;
    else node.tag = role || tag;
    const label = getLabel(el);
    if (label) node.name = label;
    if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      if (el.type && el.type !== 'text') node.type = el.type;
      if (el.placeholder) node.placeholder = el.placeholder;
      if (el.value) node.value = el.value.length > 40 ? el.value.slice(0, 37) + '...' : el.value;
    }
    if (el.tagName === 'SELECT') {
      const opt = el.options[el.selectedIndex];
      if (opt) node.value = opt.text.slice(0, 30);
    }
    if (el.tagName === 'INPUT' && (el.type === 'checkbox' || el.type === 'radio')) {
      node.checked = !!el.checked;
    }
    if (el.tagName === 'A' && el.href) {
      try { node.href = new URL(el.href).pathname.slice(0, 60); } catch { node.href = el.href.slice(0, 60); }
    }
    if (el.disabled) node.disabled = true;
    if (childNodes.length > 0) node.children = childNodes;
    return node;
  }

  const tree = walk(document.body, 0);
  let visibleCount = 0, offscreenCount = 0;
  function countRefs(n) {
    if (!n) return;
    if (n.ref) { n.offscreen ? offscreenCount++ : visibleCount++; }
    if (n.children) n.children.forEach(countRefs);
  }
  countRefs(tree);

  // Dialogs, cookie banners and other things sitting on top of the page. They
  // intercept clicks meant for what is underneath, so they are reported with
  // the refs of their buttons.
  const CONSENT = /accept|agree|allow|consent|got it|ok(ay)?|continue|close|dismiss|reject|decline|no thanks|not now|later/i;
  function overlayButtons(root) {
    const out = [];
    for (const el of root.querySelectorAll('button,[role="button"],a,input[type="button"],input[type="submit"]')) {
      const ref = refByElement.get(el);
      if (!ref) continue;
      out.push({ ref: ref, name: cap(getLabel(el), 40) });
      if (out.length >= 6) break;
    }
    return out;
  }
  const overlays = [];
  const seenOverlay = new Set();
  const addOverlay = (el, kind) => {
    if (seenOverlay.has(el) || overlays.length >= 3) return;
    for (const other of seenOverlay) if (other.contains(el) || el.contains(other)) return;
    if (visibilityOf(el) !== 'visible') return;
    const buttons = overlayButtons(el);
    if (buttons.length === 0) return;
    seenOverlay.add(el);
    overlays.push({ kind: kind, text: cap(el.innerText || '', 120), buttons: buttons });
  };
  for (const el of document.querySelectorAll('[role="dialog"],[role="alertdialog"],[aria-modal="true"],dialog[open]')) {
    addOverlay(el, 'dialog');
  }
  for (const el of document.querySelectorAll('body *')) {
    if (overlays.length >= 3) break;
    let position;
    try { position = getComputedStyle(el).position; } catch { continue; }
    if (position !== 'fixed' && position !== 'sticky') continue;
    const r = el.getBoundingClientRect();
    const covers = (r.width * r.height) / (vpW * vpH) > 0.2;
    const consent = CONSENT.test(el.innerText || '') && /cookie|consent|privacy|sign in|log in|subscribe|newsletter|notification/i.test(el.innerText || '');
    if (covers || consent) addOverlay(el, consent ? 'banner' : 'overlay');
  }

  return {
    title: document.title,
    url: location.href,
    tree: tree,
    refCount: visibleCount + offscreenCount,
    visibleCount: visibleCount,
    offscreenCount: offscreenCount,
    overlays: overlays,
  };
})()`;

/** Where the page is, for a model that wants the gist without a tree. */
export const PAGE_SUMMARY_JS = `(function() {
  const clean = (t) => String(t ?? '').replace(/\\s+/g, ' ').trim();
  const headings = [...document.querySelectorAll('h1,h2,h3')]
    .map(h => clean(h.innerText)).filter(Boolean).slice(0, 8);
  const active = document.activeElement;
  const focused = active && active !== document.body
    ? active.tagName.toLowerCase() + (active.getAttribute('aria-label') || active.placeholder || active.name ? ' "' + clean(active.getAttribute('aria-label') || active.placeholder || active.name) + '"' : '')
    : null;
  const main = document.querySelector('main, [role="main"], article') || document.body;
  const dialogs = [...document.querySelectorAll('[role="dialog"],[role="alertdialog"],dialog[open]')]
    .map(d => clean(d.innerText).slice(0, 120)).filter(Boolean).slice(0, 2);
  return {
    title: document.title,
    url: location.href,
    headings: headings,
    focused: focused,
    dialogs: dialogs,
    text: clean(main.innerText || '').slice(0, 600),
    scrolled: Math.round(window.scrollY),
    pageHeight: Math.round(document.documentElement.scrollHeight),
    viewportHeight: window.innerHeight,
  };
})()`;

export interface PageSummary {
  title: string;
  url: string;
  headings: string[];
  focused: string | null;
  dialogs: string[];
  text: string;
  scrolled: number;
  pageHeight: number;
  viewportHeight: number;
}

export function formatPageSummary(summary: PageSummary): string {
  const lines = [`Page: ${summary.title}`, `URL: ${summary.url}`];

  if (summary.dialogs.length > 0)
    lines.push(`Dialog on top: ${summary.dialogs.join(" | ")}`);
  if (summary.headings.length > 0)
    lines.push(`Headings: ${summary.headings.join(" · ")}`);
  if (summary.focused != null) lines.push(`Focused: ${summary.focused}`);

  const pages = Math.max(
    1,
    Math.ceil(summary.pageHeight / Math.max(1, summary.viewportHeight))
  );
  const at =
    Math.floor(summary.scrolled / Math.max(1, summary.viewportHeight)) + 1;
  if (pages > 1) lines.push(`Scroll: screen ${at} of ${pages}`);
  if (summary.text.length > 0) lines.push("", summary.text);

  return lines.join("\n");
}

export interface SnapshotOverlay {
  kind: "dialog" | "banner" | "overlay";
  text: string;
  buttons: Array<{ ref: string; name: string }>;
}

export function formatOverlays(
  overlays: SnapshotOverlay[] | undefined
): string {
  if (overlays == null || overlays.length === 0) return "";

  return overlays
    .map((overlay) => {
      const buttons = overlay.buttons
        .map((button) => `${button.ref} "${button.name}"`)
        .join(", ");

      return `On top of the page (${overlay.kind}): "${overlay.text}" — buttons: ${buttons}. Dismiss it before clicking underneath.`;
    })
    .join("\n");
}

/** One element of the in-page walk above, as the script returns it. */
export interface SnapshotNode {
  ref?: string;
  selector?: string;
  tag?: string;
  name?: string;
  type?: string;
  placeholder?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  href?: string;
  offscreen?: boolean;
  readonly?: boolean;
  unreachable?: boolean;
  children?: SnapshotNode[];
}

export function formatTree(node: SnapshotNode | null, depth: number): string {
  if (!node) return "";
  const pad = "  ".repeat(depth);
  let line = "";
  if (node.ref) {
    line = `${pad}${node.ref} [${node.tag}]`;
    if (node.readonly) line += " (text)";
    if (node.offscreen) line += " [offscreen]";
  } else {
    line = `${pad}[${node.tag}]`;
    if (node.unreachable) line += " (no ref — not addressable by selector)";
  }
  if (node.name) line += ` "${node.name}"`;
  if (node.type) line += ` type=${node.type}`;
  if (node.placeholder) line += ` placeholder="${node.placeholder}"`;
  if (node.value != null) line += ` value="${node.value}"`;
  if (node.checked === true) line += " [checked]";
  if (
    node.checked === false &&
    (node.type === "checkbox" || node.type === "radio")
  )
    line += " [unchecked]";
  if (node.disabled) line += " [disabled]";
  if (node.href) line += ` → ${node.href}`;
  const lines = [line];
  if (node.children) {
    for (const child of node.children) {
      lines.push(formatTree(child, depth + 1));
    }
  }
  return lines.join("\n");
}

/**
 * The tree as text, bounded: a 2,000-row list is 475KB, the rest of the turn's
 * context. Cut at a line boundary so no ref is half-written, with a note on
 * what was dropped, since a silently truncated tree reads as a page that ends.
 */
export function renderTree(
  node: SnapshotNode | null,
  limit = 20_000
): { text: string; omittedRefs: number } {
  const full = formatTree(node, 0);

  if (full.length <= limit) return { text: full, omittedRefs: 0 };

  const kept = full.slice(0, full.lastIndexOf("\n", limit) + 1 || limit);
  const dropped = full.slice(kept.length);
  const omittedRefs = (dropped.match(/^\s*@e\d+/gm) ?? []).length;

  return {
    text:
      `${kept}\n... ${omittedRefs} more element${omittedRefs === 1 ? "" : "s"} not shown — the page is too large to ` +
      "describe in full.\nScroll to bring the part you want into view and snapshot again, or use " +
      "browser_snapshot text with a selector, or browser_execute to query the DOM for just what you need.",
    omittedRefs,
  };
}

export function flattenNodes(
  node: SnapshotNode | null | undefined
): SnapshotNode[] {
  if (node == null) return [];

  return [node, ...(node.children ?? []).flatMap(flattenNodes)];
}

const matchesFind = (node: SnapshotNode, needle: string): boolean => {
  const haystack = [
    node.name,
    node.placeholder,
    node.value,
    node.href,
    node.tag,
  ]
    .filter((part): part is string => typeof part === "string")
    .join(" ")
    .toLowerCase();

  return haystack.includes(needle.toLowerCase());
};

/**
 * Only nodes matching `find`, or only clickable ones. Flat, since the caller
 * wanted candidates rather than the page's structure.
 */
export function filterSnapshot(
  tree: SnapshotNode | null,
  options: { find?: string; interactiveOnly?: boolean },
  limit = 40
): { text: string; count: number } {
  const needle = options.find?.trim() ?? "";
  const nodes = flattenNodes(tree).filter((node) => {
    if (node.ref == null) return false;
    if (options.interactiveOnly === true && node.readonly === true)
      return false;

    return needle.length === 0 || matchesFind(node, needle);
  });
  const shown = nodes.slice(0, limit);
  const lines = shown.map((node) =>
    formatTree({ ...node, children: undefined }, 0)
  );

  if (nodes.length > shown.length)
    lines.push(`... ${nodes.length - shown.length} more matches not shown`);

  return { text: lines.join("\n"), count: nodes.length };
}

/**
 * What a fresh snapshot shows that the previous ref map did not. Refs are
 * stable, so a ref absent from the old map is an element that appeared.
 */
export function diffRefs(
  before: ReadonlyMap<string, string>,
  tree: SnapshotNode | null
): { added: SnapshotNode[]; removed: number } {
  const seen = new Set<string>();
  const added: SnapshotNode[] = [];

  for (const node of flattenNodes(tree)) {
    if (node.ref == null) continue;
    seen.add(node.ref);
    if (!before.has(node.ref)) added.push(node);
  }

  let removed = 0;
  for (const ref of before.keys()) if (!seen.has(ref)) removed += 1;

  return { added, removed };
}

export function extractRefMap(
  node: SnapshotNode | null,
  map: Map<string, string>
): void {
  if (!node) return;
  if (node.ref && node.selector) map.set(node.ref, node.selector);
  if (node.children) {
    for (const child of node.children) extractRefMap(child, map);
  }
}

export const GET_ELEMENT_CENTER_JS = (sel: string): string => `(function(){
  const el = document.querySelector(${JSON.stringify(sel)});
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
})()`;
