/**
 * Turning an HTML deck into a PDF, one page per slide, with the Chromium the
 * app already ships. Pagination is not left to the page: templates' print CSS
 * is an afterthought or absent, so the exporter measures the design size on
 * screen and injects one stylesheet that pins every slide to that box.
 */
import fs from "fs/promises";
import path from "path";

import { BrowserWindow } from "electron";

import { exportDeckPptx } from "./deck-pptx-export";

export type DeckPdfOptions = {
  /** Absolute path to the deck's HTML file. */
  htmlPath: string;
  /** Where to write the PDF; defaults to the HTML path with a .pdf suffix. */
  outputPath?: string;
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
 * Print stylesheet for the measured design size: containers back to block
 * flow, slides pinned to the box and made visible, one slide per page.
 */
const printStyles = (widthPx: number, heightPx: number): string => `
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

export const exportDeckPdf = async (
  options: DeckPdfOptions
): Promise<DeckPdfResult> => {
  const htmlPath = path.resolve(options.htmlPath);
  const stat = await fs.stat(htmlPath).catch(() => null);
  if (stat == null || !stat.isFile()) {
    throw new Error(`No such HTML file: ${htmlPath}`);
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
    await win.webContents.insertCSS(printStyles(widthPx, heightPx));
    if (measured.hasStage) {
      await win.webContents.executeJavaScript(
        shadowOverride(widthPx, heightPx)
      );
    }

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
    const exported = await exportDeckPptx(win, pdfPath).catch(
      (error: unknown) => {
        pptxError = error instanceof Error ? error.message : String(error);
        console.error("[deck] pptx export failed:", error);

        return null;
      }
    );

    return {
      pdfPath,
      slides: measured.slides,
      widthPx,
      heightPx,
      bytes: data.length,
      pptxPath: exported?.pptxPath ?? null,
      pptxError,
    };
  } finally {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
  }
};
