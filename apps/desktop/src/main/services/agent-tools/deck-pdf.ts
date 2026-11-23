/**
 * Turning an HTML deck into a PDF, one page per slide, with the Chromium the
 * app already ships. Pagination is not left to the page: templates' print CSS
 * is an afterthought or absent, so the exporter measures the design size on
 * screen and injects one stylesheet that pins every slide to that box.
 */
import fs from "fs/promises";
import path from "path";

import { modelPath } from "@abacus-ai/agent/model-path";
import { BrowserWindow } from "electron";

import { GROW_SLIDES } from "./deck-grow";
import { exportDeckPptx, SHOW_ANIMATED_TEXT } from "./deck-pptx-export";
import { pinViewport } from "./deck-viewport";

export type DeckPdfOptions = {
  /** Absolute path to the deck's HTML file. */
  htmlPath: string;
  /** Where to write the PDF; defaults to the HTML path with a .pdf suffix. */
  outputPath?: string;
  /**
   * The words a filler wrote into a template: any of them drawn over another
   * is reported back (overlaps), as the design system's prints are.
   */
  filled?: string[];
  /** Overrides the detected slide size, in CSS pixels. */
  widthPx?: number;
  heightPx?: number;
};

export type DeckPdfResult = {
  pdfPath: string;
  slides: number;
  widthPx: number;
  heightPx: number;
  bytes: number;
  /** The editable .pptx, or null: a finished PDF must not be lost over it. */
  pptxPath: string | null;
  pptxError?: string | null;
  /** The cover's largest text as printed. */
  coverTitle?: string;
  /** Filled text drawn over other filled text, slide by slide. */
  overlaps?: string[];
};

/** Slide size assumed when a deck gives no usable hint (16:9 at 720p). */
const FALLBACK_SIZE = { widthPx: 1280, heightPx: 720 };

const EXPORT_TIMEOUT_MS = 120_000;

/** Grace period after fonts and images report ready, for late layout work. */
const SETTLE_MS = 400;

/**
 * Design size and slide count. `<deck-stage>` states its size; otherwise the
 * first slide's box, since templates scale the container, not the slide.
 */
const MEASURE_DECK = `(() => {
  const stage = document.querySelector('deck-stage');
  const sections = stage
    ? stage.querySelectorAll(':scope > section')
    : document.querySelectorAll('section.slide, section[data-slide], .slide');
  const first = sections[0];

  // \`offsetWidth\`/\`offsetHeight\`, not \`getBoundingClientRect\`: decks scale
  // themselves to the viewport with a transform, and the rect reports the
  // scaled box while the offsets report the authored one.
  let widthPx = first ? first.offsetWidth : 0;
  let heightPx = first ? first.offsetHeight : 0;

  // An explicit @page rule is the deck's own statement of its page size and
  // outranks a measurement.
  for (const sheet of document.styleSheets) {
    let rules;
    try { rules = sheet.cssRules } catch { continue }  // cross-origin sheet
    for (const rule of rules ?? []) {
      const size = rule.constructor?.name === 'CSSPageRule' ? rule.style?.size : null;
      const match = typeof size === 'string' ? size.match(/([\\d.]+)px\\s+([\\d.]+)px/) : null;
      if (match) { widthPx = Math.round(Number(match[1])); heightPx = Math.round(Number(match[2])); }
    }
  }

  const attrW = stage ? Number(stage.getAttribute('width')) : NaN;
  const attrH = stage ? Number(stage.getAttribute('height')) : NaN;
  if (Number.isFinite(attrW) && attrW > 0) widthPx = attrW;
  if (Number.isFinite(attrH) && attrH > 0) heightPx = attrH;

  return { slides: sections.length, widthPx, heightPx, hasStage: Boolean(stage) };
})()`;

/** Swapping webfonts and undecoded images print as fallback type and blanks. */
const AWAIT_READY = `(async () => {
  try { await document.fonts.ready } catch { /* no font API: nothing to wait on */ }
  await Promise.all([...document.images].map((img) =>
    img.complete ? null : new Promise((resolve) => {
      // addEventListener, not onload/onerror: assigning the properties would
      // clobber handlers the page itself installed.
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })));
  await new Promise((resolve) => setTimeout(resolve, ${SETTLE_MS}));
  return true;
})()`;

/**
 * Prepares the DOM for pagination. Ancestors up to `<body>` are tagged so the
 * stylesheet can return them to block flow (a slide inside flex/grid will not
 * paginate). Each slide is wrapped in a page box and taken out of flow, since
 * in-flow content fragments and the slide's overflow clips the remainder. The
 * last slide is tagged because `:last-of-type` misses non-sibling slides.
 */
const MARK_DECK = `(() => {
  const stage = document.querySelector('deck-stage');
  const slides = [...(stage
    ? stage.querySelectorAll(':scope > section')
    : document.querySelectorAll('section.slide, section[data-slide], .slide'))];
  if (slides.length === 0) return 0;

  // A slide that centres its content with flex or grid loses that layout if
  // print forces it to block, so each slide keeps the display it uses on
  // screen. Inactive slides are hidden (display:none) and borrow the display
  // of a visible sibling, which is what they would use once shown.
  const displays = slides.map((slide) => getComputedStyle(slide).display);
  const visibleDisplay = displays.find((value) => value !== 'none') ?? 'block';

  slides.forEach((slide, index) => {
    slide.setAttribute('data-deck-slide', '');
    slide.style.setProperty(
      'display',
      displays[index] === 'none' ? visibleDisplay : displays[index],
      'important',
    );

    const parent = slide.parentElement;
    if (parent != null) {
      const page = document.createElement('div');
      page.setAttribute('data-deck-page', '');
      if (index === slides.length - 1) page.setAttribute('data-deck-last', '');
      parent.insertBefore(page, slide);
      page.appendChild(slide);
    }

    // Centring written as \`top: 50%; transform: translateY(-50%)\` does not
    // survive printing. The printed page puts such content back at its
    // untransformed position. A pure translation is exactly equivalent to a
    // margin of the same size, and margins do participate in paged layout, so
    // the offset is moved there and the transform dropped. Rotations and
    // scales are left alone: they are decoration and do not affect flow.
    for (const node of slide.querySelectorAll('*')) {
      const transform = getComputedStyle(node).transform;
      if (transform === 'none' || transform === '') continue;
      const matrix = new DOMMatrixReadOnly(transform);
      const isPureTranslation =
        matrix.a === 1 && matrix.b === 0 && matrix.c === 0 && matrix.d === 1;
      if (!isPureTranslation || (matrix.e === 0 && matrix.f === 0)) continue;

      const style = getComputedStyle(node);
      node.style.setProperty('margin-top', (parseFloat(style.marginTop) || 0) + matrix.f + 'px', 'important');
      node.style.setProperty('margin-left', (parseFloat(style.marginLeft) || 0) + matrix.e + 'px', 'important');
      node.style.setProperty('transform', 'none', 'important');
    }

    // The walk starts above the wrapper: the wrapper is the page box, not a
    // container to flatten.
    const wrapper = slide.parentElement;
    for (let node = wrapper?.parentElement ?? null; node != null && node !== document.body; node = node.parentElement) {
      node.setAttribute('data-deck-container', '');
    }
  });
  return slides.length;
})()`;

/**
 * A table column whose body cells the filler left empty goes, header and all:
 * a three-column brief in a four-column template table printed an empty
 * column (retired raw-grid, neo-grid-bold, sakura-chroma).
 */
const DROP_EMPTY_COLUMNS = `(() => {
  let dropped = 0;
  for (const table of document.querySelectorAll('*[data-deck-slide] table')) {
    const rows = [...table.rows];
    const body = rows.filter((row) => !row.closest('thead') && [...row.cells].every((c) => c.tagName === 'TD'));
    if (body.length === 0) continue;
    const width = Math.max(...rows.map((row) => row.cells.length));
    for (let col = width - 1; col >= 0; col--) {
      const empty = body.every((row) => !(row.cells[col]?.textContent || '').replace(/[\\s\\u2063]/g, ''));
      if (!empty || rows.some((row) => row.cells.length !== width)) continue;
      for (const row of rows) row.cells[col]?.remove();
      dropped++;
    }
  }
  return dropped;
})()`;

/**
 * A card left with only its number ("04") when the filler had fewer items
 * than the slide has cards (bug hunt f12: boxes 04 and 05 printed empty).
 * Only among three or more like siblings. Self-contained page script.
 */
const DROP_EMPTY_CARDS = `(() => {
  let dropped = 0;
  for (const slide of document.querySelectorAll('[data-deck-slide]'))
    for (const el of [...slide.querySelectorAll('*')]) {
      const parent = el.parentElement;
      if (!parent || el.children.length === 0) continue;
      const like = [...parent.children].filter((c) => c.tagName === el.tagName && c.className === el.className);
      if (like.length < 3) continue;
      const text = (el.textContent || '').replace(/[\\s\\u2063]/g, '');
      if (/^0?\\d{1,2}$/.test(text) && !el.querySelector('img, svg, canvas')) {
        el.remove();
        dropped++;
      }
    }
  return dropped;
})()`;

/**
 * Text a filler wrote, drawn over other text it wrote, on the printed slide.
 * Only filled text counts: templates lay their own decoration (a big numeral,
 * a watermark word) under text on purpose. Self-contained page script.
 */
const FILLED_OVERLAPS = (filled: string[]): string => `(() => {
  const norm = (t) => t.replace(/\\s+/g, ' ').trim();
  const filled = new Set(${JSON.stringify(filled)}.map(norm).filter((t) => t.length > 1));
  const short = (t) => (t.length > 48 ? t.slice(0, 45) + '…' : t);
  const out = [];
  [...document.querySelectorAll('[data-deck-slide]')].forEach((slide, i) => {
    const items = [];
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT);
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const text = norm(n.textContent || '');
      const el = n.parentElement;
      if (!el || !filled.has(text) || el.closest('svg')) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === 'hidden' || parseFloat(cs.opacity) < 0.5) continue;
      const range = document.createRange();
      range.selectNodeContents(n);
      for (const r of range.getClientRects())
        if (r.width > 0.5 && r.height > 0.5) items.push({ el, text, r });
    }
    // Text past the edge of a box that clips it (a card, the page) does not
    // print: a use-case slide's last row of cards was cut off (hard asks).
    for (const { el, text, r } of items) {
      for (let box = el.parentElement; box; box = box.parentElement) {
        const o = getComputedStyle(box);
        if (o.overflow === 'visible' && o.overflowY === 'visible' && o.overflowX === 'visible') {
          if (box.hasAttribute('data-deck-page')) break;
          continue;
        }
        const b = box.getBoundingClientRect();
        if (r.bottom > b.bottom + 2 || r.right > b.right + 2 || r.top < b.top - 2 || r.left < b.left - 2) {
          const line = 'slide ' + (i + 1) + ': "' + short(text) + '" is cut off at the edge of its box';
          if (!out.includes(line)) out.push(line);
          break;
        }
        if (box.hasAttribute('data-deck-page')) break;
      }
    }
    for (let a = 0; a < items.length; a++)
      for (let b = a + 1; b < items.length; b++) {
        const x = items[a], y = items[b];
        if (x.el === y.el || x.el.contains(y.el) || y.el.contains(x.el)) continue;
        const w = Math.min(x.r.right, y.r.right) - Math.max(x.r.left, y.r.left);
        const h = Math.min(x.r.bottom, y.r.bottom) - Math.max(x.r.top, y.r.top);
        if (w <= 3 || h <= Math.max(3, Math.min(x.r.height, y.r.height) * 0.35)) continue;
        const line = 'slide ' + (i + 1) + ': "' + short(y.text) + '" is drawn over "' + short(x.text) + '"';
        if (!out.includes(line)) out.push(line);
      }
  });
  return out;
})()`;

/**
 * Print stylesheet for the measured design size: containers back to block
 * flow, slides pinned to the box and made visible, one slide per page.
 */
export const printStyles = (widthPx: number, heightPx: number): string => `
@page { size: ${widthPx}px ${heightPx}px; margin: 0; }
@media print {
  html, body {
    margin: 0 !important;
    padding: 0 !important;
    width: auto !important;
    height: auto !important;
    min-height: 0 !important;
    overflow: visible !important;
    background: none !important;
    display: block !important;
  }
  [data-deck-container] {
    display: block !important;
    position: static !important;
    transform: none !important;
    width: auto !important;
    height: auto !important;
    min-height: 0 !important;
    max-height: none !important;
    padding: 0 !important;
    margin: 0 !important;
    gap: 0 !important;
    overflow: visible !important;
    scroll-snap-type: none !important;
    perspective: none !important;
    filter: none !important;
  }
  /* The page box: the only thing that paginates. */
  [data-deck-page] {
    position: relative !important;
    display: block !important;
    width: ${widthPx}px !important;
    height: ${heightPx}px !important;
    margin: 0 !important;
    padding: 0 !important;
    overflow: hidden !important;
    break-inside: avoid !important;
    page-break-inside: avoid !important;
    break-after: page !important;
    page-break-after: always !important;
  }
  /* The slide fills its page box out of flow, so nothing inside fragments. */
  [data-deck-slide] {
    position: absolute !important;
    inset: 0 !important;
    margin: 0 !important;
    transform: none !important;
    opacity: 1 !important;
    visibility: visible !important;
    scroll-snap-align: none !important;
    width: ${widthPx}px !important;
    height: ${heightPx}px !important;
    min-height: 0 !important;
    max-height: none !important;
    overflow: hidden !important;
  }
  /* Chromium fragments inner flex and grid containers even when the slide
     itself fits a page, which drops a trailing child onto the next fragment
     where the slide's own overflow clips it away. Nothing inside a slide
     should ever break. */
  [data-deck-slide] * {
    break-inside: avoid !important;
    page-break-inside: avoid !important;
  }
  /* Some templates hide [data-anim] text until its slide is the active one
     on screen; printed, no slide is, so every slide's text would be blank. */
  ${SHOW_ANIMATED_TEXT}
  /* Without this the final break emits a trailing blank page. */
  [data-deck-last] {
    break-after: auto !important;
    page-break-after: auto !important;
  }
  /* On-screen deck chrome that should not reach paper: navigation buttons,
     keyboard hints, progress bars. Page numbers are left alone. Those belong
     on a printed slide. */
  .overlay, .tapzones, .deck-nav, .deck-hint, .progress, [data-deck-chrome],
  [class*="keyboard-hint"], [class*="nav-btn"], [class*="nav-controls"],
  [class*="progress-bar"], [class*="deck-controls"] {
    display: none !important;
  }
  * { -webkit-print-color-adjust: exact !important; print-color-adjust: exact !important; }
}`;

/**
 * A template's on-screen counter ("3 / 10") is one fixed element its script
 * updates; printed, it repeats the first slide's number on every page. Each
 * printed slide gets its own number in the counter's place, and the shared
 * one is hidden. Templates mark it by class or by id. A slide whose own text
 * already shows its number is left with that one.
 */
export const NUMBER_SLIDES = `(() => {
  const counter = document.querySelector('.slide-counter, #slide-counter');
  if (counter == null) return 0;
  const slides = [...document.querySelectorAll('[data-deck-slide]')];
  const look = getComputedStyle(counter);
  const box = counter.getBoundingClientRect();
  const onRight = box.left + box.width / 2 > window.innerWidth / 2;
  slides.forEach((slide, index) => {
    // A slide that already shows its own number ("03 / 07") gets no second one.
    const own = new RegExp('(^|[^0-9])0*' + (index + 1) + ' */ *0*' + slides.length + '([^0-9]|$)');
    if (own.test(slide.textContent || '')) return;
    const number = document.createElement('div');
    number.textContent = (index + 1) + ' / ' + slides.length;
    // Read left to right in a right-to-left deck too ("1 / 14", not "14 / 1").
    number.dir = 'ltr';
    for (const key of ['fontSize', 'fontFamily', 'fontWeight', 'letterSpacing', 'color']) {
      number.style[key] = look[key];
    }
    number.style.bottom = (window.innerHeight - box.bottom) + 'px';
    if (onRight) number.style.right = (window.innerWidth - box.right) + 'px';
    else number.style.left = box.left + 'px';
    number.style.position = 'absolute';
    number.style.zIndex = '20';
    number.style.fontVariantNumeric = 'tabular-nums';
    if (getComputedStyle(slide).position === 'static') slide.style.position = 'relative';
    slide.appendChild(number);
  });
  counter.style.setProperty('display', 'none', 'important');
  return slides.length;
})()`;

/**
 * Text a filler wrote longer than its slot runs off the slide, or past a
 * card that clips it, and is cut. Each printed slide's overflowing text is
 * shrunk, a step at a time, until it fits (to half its size at most); what
 * still does not fit is reported by the caller's own checks, not hidden.
 * Text pushed off the slide by the text above it shrinks with that text.
 *
 * Text that fits its card still counts when the card, grown by it, runs off
 * the slide. The slide's edge is taken at its printed size: slotted into
 * <deck-stage> a slide has no height of its own on screen. Text placed with
 * position absolute is left to bleed past the edge, as decorations do.
 */
export const fitSlides = (
  widthPx: number,
  heightPx: number
): string => `(() => {
  let shrunk = 0;
  for (const slide of document.querySelectorAll('[data-deck-slide]')) {
    const own = slide.getBoundingClientRect();
    const edge = { left: own.left, top: own.top, right: own.right, bottom: own.top + own.width * ${heightPx / widthPx} };
    // The nearest box that clips the text or is drawn around it (a card
    // with a fill or border, a figure panel), or else the slide.
    const cardOf = (el) => {
      for (let at = el.parentElement; at && at !== slide; at = at.parentElement) {
        const cs = getComputedStyle(at);
        const clips = /hidden|clip/.test(cs.overflow + ' ' + cs.overflowX + ' ' + cs.overflowY);
        const fill = cs.backgroundColor;
        const drawn = (fill && fill !== 'transparent' && !/rgba\\([^)]*,\\s*0\\)$/.test(fill)) || (/solid|dashed|dotted|double/.test(cs.borderTopStyle + ' ' + cs.borderLeftStyle) && (parseFloat(cs.borderTopWidth) > 0 || parseFloat(cs.borderLeftWidth) > 0));
        if (clips || drawn) return at.getBoundingClientRect();
      }
      return edge;
    };
    // Off the slide: the text, or the card it is drawn in. Text placed
    // with position absolute and drawn in no card is a decoration.
    const offSlide = (el, box, limit) => {
      if (limit === edge && /absolute|fixed/.test(getComputedStyle(el).position)) return false;
      const bottom = limit === edge ? box.bottom : Math.max(box.bottom, limit.bottom);
      const right = limit === edge ? box.right : Math.max(box.right, limit.right);
      // The top too: a bottom-anchored statement grows upward and was cut off
      // at the slide's top edge (live, studio).
      return bottom > edge.bottom + 1 || right > edge.right + 1 || box.top < edge.top - 1;
    };
    const hasText = (el) => [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim().length > 0);
    const over = () => [...slide.querySelectorAll('*')].filter((el) => {
      if (el.children.length > 0 && el.textContent.trim().length === 0) return false;
      if (!hasText(el)) return false;
      const box = el.getBoundingClientRect();
      const limit = cardOf(el);
      // Its text running past its own box (a figure as wide as its card)
      // counts too; the boxes alone never show that.
      const spills = el.clientWidth > 0 && el.scrollWidth > el.clientWidth + 1;
      return box.width > 0 && (spills || offSlide(el, box, limit) || (limit !== edge && (box.bottom > limit.bottom + 1 || box.right > limit.right + 1)));
    });
    const shrink = (el, by, floor) => {
      const size = parseFloat(getComputedStyle(el).fontSize);
      const start = Number(el.dataset.fitStart || size);
      el.dataset.fitStart = String(start);
      if (size * by >= start * floor) { el.style.setProperty('font-size', (size * by) + 'px', 'important'); shrunk++; }
    };
    for (let step = 0; step < 8; step++) {
      const list = over();
      if (list.length === 0) break;
      for (const el of list) shrink(el, 0.88, 0.5);
    }
    // Text still off the slide, or in a card that is, was pushed there by
    // the text above it, which fits where it is: the slide's flowing text
    // shrinks together, a little at a time, so its proportions hold.
    const flowing = [...slide.querySelectorAll('*')].filter((el) =>
      hasText(el) && !/absolute|fixed/.test(getComputedStyle(el).position));
    const pushedOff = () => flowing.some((el) => {
      const box = el.getBoundingClientRect();
      return box.width > 0 && offSlide(el, box, cardOf(el));
    });
    for (let step = 0; step < 6 && pushedOff(); step++) {
      for (const el of flowing) shrink(el, 0.92, 0.6);
    }
  }
  return shrunk;
})()`;

/** `<deck-stage>` keeps its rules in a shadow root document CSS cannot reach. */
const shadowOverride = (widthPx: number, heightPx: number): string => `(() => {
  const stage = document.querySelector('deck-stage');
  if (stage == null || stage.shadowRoot == null) return false;
  const style = document.createElement('style');
  style.textContent = \`@media print {
    ::slotted(*) {
      position: relative !important;
      inset: auto !important;
      width: ${widthPx}px !important;
      height: ${heightPx}px !important;
      opacity: 1 !important;
      visibility: visible !important;
      overflow: hidden !important;
      break-after: page;
      break-inside: avoid;
    }
    ::slotted(*:last-child) { break-after: auto; }
    .canvas, .stage { transform: none !important; width: auto !important; height: auto !important; }
    .overlay, .tapzones { display: none !important; }
  }\`;
  stage.shadowRoot.appendChild(style);
  return true;
})()`;

/** Runs `measure` with the page in print media, as it will be printed. */
const inPrintMedia = async <T>(
  win: BrowserWindow,
  measure: () => Promise<T>
): Promise<T> => {
  const tools = win.webContents.debugger;
  const attached = !tools.isAttached();
  try {
    if (attached) tools.attach("1.3");
    await tools.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
  } catch {
    return await measure();
  }
  try {
    return await measure();
  } finally {
    await tools
      .sendCommand("Emulation.setEmulatedMedia", { media: "" })
      .catch(() => {});
    if (attached) tools.detach();
  }
};

export const exportDeckPdf = async (
  options: DeckPdfOptions
): Promise<DeckPdfResult> => {
  const htmlPath = path.resolve(options.htmlPath);
  const stat = await fs.stat(htmlPath).catch(() => null);
  if (stat == null || !stat.isFile()) {
    throw new Error(`No such HTML file: ${modelPath(htmlPath)}`);
  }

  const pdfPath = path.resolve(
    options.outputPath ?? htmlPath.replace(/\.[^./\\]+$/, "") + ".pdf"
  );

  const win = new BrowserWindow({
    show: false,
    // Templates size slides in viewport units; window size would include the
    // frame and hand the deck a viewport ~32px short of 16:9.
    useContentSize: true,
    width: options.widthPx ?? FALLBACK_SIZE.widthPx,
    height: options.heightPx ?? FALLBACK_SIZE.heightPx,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      webSecurity: true,
    },
  });

  const timeout = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, EXPORT_TIMEOUT_MS);

  try {
    await win.loadFile(htmlPath);
    // After loading: attaching to a window with nothing loaded crashed it.
    await pinViewport(win, {
      widthPx: options.widthPx ?? FALLBACK_SIZE.widthPx,
      heightPx: options.heightPx ?? FALLBACK_SIZE.heightPx,
    });
    await win.webContents.executeJavaScript(AWAIT_READY);

    const measured = (await win.webContents.executeJavaScript(
      MEASURE_DECK
    )) as {
      slides: number;
      widthPx: number;
      heightPx: number;
      hasStage: boolean;
    };

    const widthPx =
      options.widthPx ??
      (measured.widthPx > 0 ? measured.widthPx : FALLBACK_SIZE.widthPx);
    const heightPx =
      options.heightPx ??
      (measured.heightPx > 0 ? measured.heightPx : FALLBACK_SIZE.heightPx);

    await win.webContents.executeJavaScript(MARK_DECK);
    await win.webContents.executeJavaScript(NUMBER_SLIDES);
    if (options.filled != null) {
      await win.webContents.executeJavaScript(DROP_EMPTY_COLUMNS);
      await win.webContents.executeJavaScript(DROP_EMPTY_CARDS);
    }
    // Short content grows into its slide first; overflow is then shrunk.
    await win.webContents.executeJavaScript(GROW_SLIDES);
    await win.webContents.executeJavaScript(fitSlides(widthPx, heightPx));
    // Measured as it will print: after growing and fitting, before printing.
    // The cover's title as printed: its largest text (a cover check reads it).
    const coverTitle = (await win.webContents.executeJavaScript(`(() => {
      const first = document.querySelector('section.slide, section[data-slide], .slide');
      if (!first) return '';
      const leaves = [...first.querySelectorAll('*')].filter((e) =>
        [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()) && e.getClientRects().length > 0);
      const size = (e) => parseFloat(getComputedStyle(e).fontSize) || 0;
      const top = Math.max(0, ...leaves.map(size));
      return leaves.filter((e) => size(e) >= top * 0.8).map((e) => e.innerText.trim()).join(' ');
    })()`)) as string;
    await win.webContents.insertCSS(printStyles(widthPx, heightPx));
    if (measured.hasStage) {
      await win.webContents.executeJavaScript(
        shadowOverride(widthPx, heightPx)
      );
    }

    // In print media, as the PDF lays it out: measured on screen, a card cut
    // off in the print fitted and passed (hard asks).
    const overlaps =
      options.filled != null && options.filled.length > 0
        ? await inPrintMedia(
            win,
            async () =>
              (await win.webContents.executeJavaScript(
                FILLED_OVERLAPS(options.filled!)
              )) as string[]
          )
        : [];
    const data = await win.webContents.printToPDF({
      printBackground: true,
      preferCSSPageSize: true,
      margins: { top: 0, bottom: 0, left: 0, right: 0 },
      landscape: widthPx >= heightPx,
    });

    await fs.writeFile(pdfPath, data);

    // After the print, so a failure here cannot cost the PDF. The reason
    // travels with the result: a silent null leaves nobody told.
    let pptxError: string | null = null;
    const exported = await exportDeckPptx(win, pdfPath, {
      widthPx,
      heightPx,
    }).catch((error: unknown) => {
      pptxError = error instanceof Error ? error.message : String(error);
      console.error("[deck] pptx export failed:", error);

      return null;
    });

    return {
      pdfPath,
      slides: measured.slides,
      widthPx,
      heightPx,
      bytes: data.length,
      pptxPath: exported?.pptxPath ?? null,
      pptxError,
      ...(overlaps.length > 0 ? { overlaps } : {}),
      ...(coverTitle ? { coverTitle } : {}),
    };
  } finally {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
  }
};
