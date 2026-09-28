/**
 * HTML to PowerPoint, by asking the layout engine where everything ended up.
 *
 * No CSS-to-OOXML translation: the deck is already open in Chromium for
 * printing, so every visible text run and solid box is read back as absolute
 * geometry and becomes its own editable shape. Gradients, shadows, transforms
 * and pseudo-elements are dropped; text is placed per run, not reflowed.
 */
import fs from "fs/promises";
import path from "path";

import type { BrowserWindow } from "electron";
import PptxGenJsImport from "pptxgenjs";

// The package ships as ESM-with-default under CJS interop; both shapes appear
// depending on how the bundler resolves it.
const PptxGenJs = ((PptxGenJsImport as unknown as { default?: unknown })
  .default ?? PptxGenJsImport) as new () => PptxInstance;

/** Only the surface this file uses; the package's own types are ESM-only. */
interface PptxInstance {
  defineLayout(layout: { name: string; width: number; height: number }): void;
  layout: string;
  addSlide(): PptxSlide;
  writeFile(options: { fileName: string }): Promise<string>;
}

interface PptxSlide {
  background: { color: string };
  addText(text: string, options: Record<string, unknown>): void;
  addShape(shape: string, options: Record<string, unknown>): void;
  addImage(options: Record<string, unknown>): void;
}

/** A 16:9 slide, in inches: the canvas every deck template is designed against. */
const SLIDE_W = 13.333;
const SLIDE_H = 7.5;

/**
 * Text smaller than this is almost always decoration a slide repeats (a page
 * number, a rule label), and each one costs a text box in the result.
 */
const MIN_PT = 5;

export type DeckPptxResult = { pptxPath: string; slides: number };

type Run = {
  text: string;
  x: number;
  y: number;
  w: number;
  h: number;
  size: number;
  color: string;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  font: string;
  transform: string;
};

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  radius: number;
};

type Picture = { x: number; y: number; w: number; h: number; data: string };

/**
 * Image formats that may be handed to pptxgenjs, recognised by their own bytes.
 *
 * pptxgenjs sizes images with `image-size`, whose ICNS, JXL and HEIF parsers
 * loop forever on a crafted buffer (CVE-2025-71329/71330) and would freeze the
 * main process. Checked by signature, not the `data:` media type, because
 * `image-size` sniffs content and ignores the label. SVG is text and safe.
 */
const IMAGE_SIGNATURES: ReadonlyArray<{ name: string; bytes: number[] }> = [
  { name: "png", bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { name: "jpeg", bytes: [0xff, 0xd8, 0xff] },
  { name: "gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // "RIFF", then four bytes of length, then "WEBP".
  { name: "riff", bytes: [0x52, 0x49, 0x46, 0x46] },
];

/**
 * Whether a captured `data:` URI is an image we are willing to size. An
 * allowlist, so an unconsidered format fails closed.
 */
export function isSupportedImage(dataUri: string): boolean {
  const match = /^data:([^;,]*)[^,]*,(.*)$/s.exec(dataUri);

  if (match?.[2] == null) return false;

  const mediaType = (match[1] ?? "").toLowerCase();

  if (mediaType === "image/svg+xml") return true;

  if (!/;base64/i.test(dataUri.slice(0, dataUri.indexOf(",")))) return false;

  let head: Buffer;

  try {
    // 16 bytes covers every signature above, including WebP's "WEBP" at 8.
    head = Buffer.from(match[2].slice(0, 24), "base64");
  } catch {
    return false;
  }

  return IMAGE_SIGNATURES.some(({ name, bytes }) => {
    const matches = bytes.every((byte, index) => head[index] === byte);

    if (!matches) return false;
    // RIFF is a container: only the WebP flavour of it is an image.
    if (name === "riff")
      return head.subarray(8, 12).toString("ascii") === "WEBP";

    return true;
  });
}

type SlideCapture = {
  width: number;
  height: number;
  background: string;
  boxes: Box[];
  runs: Run[];
  images: Picture[];
};

/**
 * Runs inside the page, once per deck; everything it returns is measured by the
 * layout engine. A string because it is evaluated in the renderer.
 */
const EXTRACT = String.raw`(() => {
  const slides = [...document.querySelectorAll('.slide')]
  const hex = (value) => {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?/i.exec(value || '')
    if (!m) return null
    if (m[4] !== undefined && parseFloat(m[4]) < 0.06) return null
    return [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
  }

  return slides.map((slide) => {
    const frame = slide.getBoundingClientRect()
    const style = getComputedStyle(slide)
    const boxes = []
    const runs = []
    const images = []

    // Painted areas: a solid background on any descendant is a shape in the result.
    // The slide's own background becomes the slide background instead.
    for (const el of slide.querySelectorAll('*')) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.06) continue
      const r = el.getBoundingClientRect()
      if (r.width < 3 || r.height < 3) continue
      const fill = hex(cs.backgroundColor)
      if (fill == null) continue
      // Full-slide fills are the background, not a box on top of it.
      if (r.width > frame.width * 0.98 && r.height > frame.height * 0.98) continue
      boxes.push({
        x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height,
        color: fill, radius: parseFloat(cs.borderTopLeftRadius) || 0,
      })
    }

    for (const img of slide.querySelectorAll('img')) {
      const r = img.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      const src = img.currentSrc || img.src || ''
      if (!src.startsWith('data:')) continue
      images.push({ x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height, data: src })
    }

    // One run per text node, measured with a Range so the box is the glyphs' own
    // box rather than the block's. A heading in a tall container would otherwise
    // land at the top of the container instead of where it is drawn.
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const text = (node.nodeValue || '').replace(/\s+/g, ' ').trim()
      if (!text) continue
      const parent = node.parentElement
      if (!parent) continue
      const cs = getComputedStyle(parent)
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.06) continue
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue

      const range = document.createRange()
      range.selectNodeContents(node)
      const r = range.getBoundingClientRect()
      range.detach()
      if (r.width < 2 || r.height < 2) continue

      const weight = parseInt(cs.fontWeight, 10)
      runs.push({
        text,
        x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height,
        size: parseFloat(cs.fontSize) || 12,
        color: hex(cs.color) || '111111',
        bold: Number.isFinite(weight) ? weight >= 600 : cs.fontWeight === 'bold',
        italic: cs.fontStyle === 'italic',
        align: ['center', 'right'].includes(cs.textAlign) ? cs.textAlign : 'left',
        font: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
        transform: cs.textTransform,
      })
    }

    return {
      width: frame.width,
      height: frame.height,
      background: hex(style.backgroundColor) || hex(getComputedStyle(document.body).backgroundColor) || 'FFFFFF',
      boxes, runs, images,
    }
  })
})()`;

/**
 * Builds the .pptx from what the page reported. Geometry is scaled by the
 * slide's measured size: templates pick their own pixel width.
 */
const build = async (
  captures: SlideCapture[],
  outputPath: string
): Promise<number> => {
  const deck = new PptxGenJs();

  deck.defineLayout({ name: "DECK16x9", width: SLIDE_W, height: SLIDE_H });
  deck.layout = "DECK16x9";

  let written = 0;

  for (const capture of captures) {
    if (capture.width < 10 || capture.height < 10) continue;

    const scaleX = SLIDE_W / capture.width;
    const scaleY = SLIDE_H / capture.height;
    const slide = deck.addSlide();

    slide.background = { color: capture.background };

    for (const box of capture.boxes) {
      slide.addShape("rect", {
        x: box.x * scaleX,
        y: box.y * scaleY,
        w: box.w * scaleX,
        h: box.h * scaleY,
        fill: { color: box.color },
        line: { type: "none" },
        ...(box.radius > 1
          ? { rectRadius: Math.min(0.2, box.radius * scaleX) }
          : {}),
      });
    }

    for (const image of capture.images) {
      // See isSupportedImage: an unsizeable format hangs the main process.
      if (!isSupportedImage(image.data)) continue;

      slide.addImage({
        data: image.data,
        x: image.x * scaleX,
        y: image.y * scaleY,
        w: image.w * scaleX,
        h: image.h * scaleY,
      });
    }

    for (const run of capture.runs) {
      // CSS px at 96dpi to points: 0.75, with the slide scale riding along.
      const points =
        run.size *
        0.75 *
        (SLIDE_W / capture.width) *
        (capture.width / 13.333) *
        (13.333 / SLIDE_W);

      if (points < MIN_PT) continue;

      const text =
        run.transform === "uppercase" ? run.text.toUpperCase() : run.text;

      slide.addText(text, {
        x: run.x * scaleX,
        // Nudged up: a PowerPoint text box adds leading above the glyphs that a
        // Range's box does not have.
        y: Math.max(0, run.y * scaleY - 0.03),
        // Slack to the slide edge so PowerPoint's wider measure does not wrap.
        w: Math.min(SLIDE_W - run.x * scaleX, run.w * scaleX + 0.35),
        h: run.h * scaleY + 0.12,
        fontSize: Math.round(points * 10) / 10,
        color: run.color,
        bold: run.bold,
        italic: run.italic,
        align: run.align,
        valign: "top",
        margin: 0,
        // A missing face falls back on the viewer's side.
        ...(run.font.length > 0 ? { fontFace: run.font } : {}),
        // Shrinking or wrapping would move text off where the design put it.
        shrinkText: false,
        fit: "none",
        isTextBox: true,
      });
    }

    written += 1;
  }

  if (written === 0) throw new Error("no slide could be measured");

  await deck.writeFile({ fileName: outputPath });

  return written;
};

/**
 * Makes the page measurable before capturing it: `deck-stage` scales the deck
 * to fit the window and hides every non-active slide, so an unprepared capture
 * measures every slide at 0x0.
 */
const PREPARE = String.raw`(async () => {
  const stage = document.querySelector('deck-stage')
  const slides = [...document.querySelectorAll('.slide')]
  const w = Number(stage && stage.getAttribute('width')) || 1920
  const h = Number(stage && stage.getAttribute('height')) || 1080

  if (stage && stage.shadowRoot) {
    // The component owns the geometry, and its shadow CSS outranks anything we
    // could set inline. For slotted elements an !important rule in the shadow
    // tree beats the light DOM's own inline !important. So ask it, rather than
    // fight it: noscale drops the fit-to-window transform, and marking every
    // slide active is what its own CSS keys visibility off. Measured on a real
    // deck: 1920x1080 and visible, against 1280x720 hidden before.
    stage.setAttribute('noscale', '')
    for (const slide of slides) slide.setAttribute('data-deck-active', '')
  } else {
    // No component in this window. Its script is a relative <script src> that
    // does not always load, and an unupgraded <deck-stage> is an inline element
    // sizing nothing, which is where the 0x0 came from. Nothing is styling the
    // slides now, so inline geometry lands unopposed.
    if (stage) {
      stage.style.display = 'block'
      stage.style.width = w + 'px'
    }
    for (const slide of slides) {
      slide.style.setProperty('position', 'relative', 'important')
      slide.style.setProperty('inset', 'auto', 'important')
      slide.style.setProperty('display', 'block', 'important')
      slide.style.setProperty('width', w + 'px', 'important')
      slide.style.setProperty('height', h + 'px', 'important')
      slide.style.setProperty('visibility', 'visible', 'important')
      slide.style.setProperty('opacity', '1', 'important')
    }
  }

  // Two frames: one for the attributes and styles to apply, one for layout to
  // settle at the new size before anything is measured.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  return slides.length
})()`;

/**
 * Every slide measuring nothing means the page was still scaled or hidden;
 * reported rather than turned into an empty file.
 */
export function unmeasurableSlides(
  captures: readonly { width: number; height: number }[]
): boolean {
  if (captures.length === 0) return true;

  return captures.every((capture) => capture.width < 10 || capture.height < 10);
}

/**
 * Exports the deck loaded in `win` as an editable .pptx. Called after the PDF
 * is printed from the same window, so a failure here cannot cost the PDF.
 */
export const exportDeckPptx = async (
  win: BrowserWindow,
  pdfPath: string
): Promise<DeckPptxResult> => {
  await win.webContents.executeJavaScript(PREPARE, true);

  const captures = (await win.webContents.executeJavaScript(
    EXTRACT,
    true
  )) as SlideCapture[];

  if (!Array.isArray(captures) || captures.length === 0)
    throw new Error("the page reported no slides");
  if (unmeasurableSlides(captures)) {
    throw new Error(
      "every slide measured 0x0. The deck was still scaled or hidden when it was captured"
    );
  }

  const pptxPath = `${pdfPath.replace(/\.pdf$/i, "")}.pptx`;

  await fs.mkdir(path.dirname(pptxPath), { recursive: true });

  return { pptxPath, slides: await build(captures, pptxPath) };
};
