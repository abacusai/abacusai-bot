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
import { fileURLToPath } from "url";

import type { BrowserWindow } from "electron";
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
  addNotes(notes: string): void;
}

/** The .pptx page width, in inches; its height follows the deck's own shape. */
const SLIDE_W = 13.333;

/**
 * The .pptx page for a deck: 13.333 inches wide, as tall as the deck's own
 * slides are for their width. A 16:9 deck is the usual 13.333 by 7.5; a
 * 1024x720 one is not stretched sideways to fit 16:9.
 */
export function slideSizeOf(
  captures: readonly { width: number; height: number }[]
): { width: number; height: number } {
  const first = captures.find((c) => c.width >= 10 && c.height >= 10);
  if (first == null) return { width: SLIDE_W, height: 7.5 };
  return {
    width: SLIDE_W,
    height: Math.round(((SLIDE_W * first.height) / first.width) * 1000) / 1000,
  };
}

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
  /** Colour alpha times the opacity of the element and its ancestors. */
  alpha: number;
  bold: boolean;
  italic: boolean;
  align: "left" | "center" | "right";
  font: string;
  transform: string;
  /** The block (heading, paragraph) the run is part of, numbered per slide. */
  block?: number;
};

type Box = {
  x: number;
  y: number;
  w: number;
  h: number;
  color: string;
  alpha: number;
  radius: number;
};

/** A picture: inline data, or a file the page loaded (read in the main process). */
type Picture = {
  x: number;
  y: number;
  w: number;
  h: number;
  data?: string;
  file?: string;
};

/** An SVG (a chart, an icon) to put in as a picture of how it printed. */
type Drawing = {
  x: number;
  y: number;
  w: number;
  h: number;
  pageX: number;
  pageY: number;
};

/**
 * One scale per block: each line takes the smallest any line of its block
 * needs (block -1 is a line on its own).
 */
export function sharedScales(scales: number[], blocks: number[]): number[] {
  const least = new Map<number, number>();
  blocks.forEach((b, i) => {
    if (b >= 0) least.set(b, Math.min(least.get(b) ?? Infinity, scales[i]!));
  });
  return scales.map((s, i) => (blocks[i]! >= 0 ? least.get(blocks[i]!)! : s));
}

/**
 * Text fainter than this is a watermark (grove's big slide number is drawn at
 * 6%); in PowerPoint it would be one more box to click past, so it is left out.
 */
const MIN_TEXT_ALPHA = 0.1;

/**
 * A font size measured in a slide's px, in points on the .pptx page: the
 * page is SLIDE_W inches (72pt each) for the slide's whole width, so a 1920px
 * slide's 96px heading is 48pt and a 1280px slide's px is the usual 0.75pt.
 */
export function pointsFor(sizePx: number, slideWidthPx: number): number {
  return (sizePx * SLIDE_W * 72) / slideWidthPx;
}

/**
 * Runs that sit on one drawn line side by side (plain text, then a bold
 * span), as one group each, left to right; anything else stands alone. A
 * run joins a line when its top is within a third of the line's height and
 * it starts no more than a word's gap after the line ends.
 */
export function lineGroups<
  T extends { x: number; y: number; w: number; h: number; size: number },
>(runs: readonly T[]): T[][] {
  const sorted = [...runs].sort((a, b) => a.y - b.y || a.x - b.x);
  const groups: T[][] = [];

  for (const run of sorted) {
    const line = groups.find((group) => {
      const end = group[group.length - 1]!;
      const gap = run.x - (end.x + end.w);
      return (
        Math.abs(run.y - group[0]!.y) < Math.max(run.h, group[0]!.h) / 3 &&
        gap > -2 &&
        gap < run.size * 0.8
      );
    });

    if (line != null) line.push(run);
    else groups.push([run]);
  }

  return groups.map((group) => group.sort((a, b) => a.x - b.x));
}

/**
 * The face the .pptx names for a template's web font: a common one of similar
 * or slightly narrower width that PowerPoint has, and LibreOffice has a
 * metric twin of. Naming the web font made a viewer without it substitute a
 * wider face, and titles ran into each other and off the slide.
 */
const FACES: Record<string, string> = {
  "bebas neue": "Arial Narrow",
  caveat: "Arial Narrow",
  lora: "Georgia",
  "playfair display": "Times New Roman",
  "bodoni moda": "Times New Roman",
  newsreader: "Times New Roman",
  "source serif 4": "Times New Roman",
  fraunces: "Georgia",
  "dm serif display": "Georgia",
  "yeseva one": "Georgia",
  "rozha one": "Georgia",
  "jetbrains mono": "Courier New",
  "ibm plex mono": "Courier New",
  "dm mono": "Courier New",
};

export function faceFor(font: string, text = ""): string {
  // Devanagari and Bengali need a face that has them: Windows ships Nirmala
  // UI; a Latin face left the .pptx to the viewer's fallback (broken
  // conjuncts in LibreOffice, bug hunt rows 10 and 13b).
  // Tamil and the other Indic scripts too: Nirmala UI has them all.
  if (/[\u0900-\u0dff]/.test(text)) return "Nirmala UI";
  const name = font.trim().toLowerCase();
  if (FACES[name] != null) return FACES[name];
  if (/\bmono\b/.test(name)) return "Courier New";
  return "Arial";
}

/** Average advance per character, in ems, of each named face (caps, lower). */
const ADVANCE: Record<string, [number, number]> = {
  Arial: [0.68, 0.5],
  "Arial Narrow": [0.56, 0.42],
  "Times New Roman": [0.68, 0.44],
  Georgia: [0.72, 0.5],
  "Courier New": [0.6, 0.6],
};

/**
 * A display line's size once its text is set in `face`: unchanged if its
 * estimated width fits `widthIn` inches, else shrunk to fit, by at most a
 * fifth. Body text (under 24pt) is never shrunk. The last resort after
 * faceFor, for titles in a face narrower than any common one.
 */
export function displayPoints(
  points: number,
  text: string,
  face: string,
  bold: boolean,
  widthIn: number
): number {
  if (points < 24 || text.length === 0) return points;
  const [caps, lower] = ADVANCE[face] ?? ADVANCE.Arial!;
  const upper = text.replace(/[^A-Z0-9]/g, "").length;
  const ems =
    (upper * caps + (text.length - upper) * lower) * (bold ? 1.06 : 1);
  const width = (ems * points) / 72;
  if (width <= widthIn) return points;
  return (
    Math.round(Math.max(points * 0.8, (points * widthIn) / width) * 10) / 10
  );
}

/**
 * The colour a gradient background averages to, as rgb(), from the stops
 * the page computed; transparent stops are skipped, and anything that is not
 * a gradient gives null. A string: it runs in the page, inside EXTRACT.
 */
export const GRADIENT_FILL = String.raw`(image) => {
  if (!/gradient\(/.test(image || '')) return null
  const stops = [...image.matchAll(/rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+))?\s*\)/g)]
    .filter((m) => m[4] === undefined || parseFloat(m[4]) > 0.06)
  if (stops.length === 0) return null
  const mean = (i) => Math.round(stops.reduce((sum, m) => sum + Number(m[i]), 0) / stops.length)
  return 'rgb(' + mean(1) + ', ' + mean(2) + ', ' + mean(3) + ')'
}`;

/** Faces with capitals only: their text prints in capitals whatever was typed. */
const CAPS_ONLY = new Set(["bebas neue"]);

/** A run's text as the .pptx should carry it in the run's stand-in face. */
export function textFor(text: string, font: string, transform: string): string {
  return transform === "uppercase" || CAPS_ONLY.has(font.trim().toLowerCase())
    ? text.toUpperCase()
    : text;
}

/**
 * A slide's background: the topmost box that covers the whole slide (coral's
 * closing panel, once it took the whole slide), else the slide's own colour,
 * the page's, or white. A string: it runs in the page, inside EXTRACT.
 */
export const SLIDE_BACKGROUND = String.raw`(slide, covering, body) =>
  covering[covering.length - 1] || slide || body || 'FFFFFF'`;

/** PowerPoint's transparency, in percent, for a measured alpha. */
export function transparencyOf(alpha: number): number {
  const clamped = Math.min(1, Math.max(0, alpha));

  return Math.round((1 - clamped) * 100);
}

/**
 * Splits one text node into the lines the browser drew it on. Each word is
 * measured on its own; a word whose top is below the middle of the line's
 * first word starts the next line (not the line's grown box: a word broken
 * across two lines made it tall enough to take in the next line, showcase
 * u01). A string because it runs in the page, inside EXTRACT.
 *
 * Placed one box per line, PowerPoint never re-wraps the text with its own
 * font metrics, which is what made wrapped titles run into the line below.
 */
export const LINES_OF = String.raw`(words) => {
  const lines = []
  for (const word of words) {
    const line = lines[lines.length - 1]
    if (line && word.top < line.mid) {
      line.end = word.end
      line.left = Math.min(line.left, word.left)
      line.right = Math.max(line.right, word.right)
      line.bottom = Math.max(line.bottom, word.bottom)
    } else {
      lines.push({ ...word, mid: word.top + (word.bottom - word.top) / 2 })
    }
  }
  return lines
}`;

/**
 * The pieces of a text node to measure one by one: its words, split after a
 * hyphen or dash, where the browser may break a line ("half-" / "portion").
 * A string because it runs in the page, inside EXTRACT.
 */
export const WORD_PIECES = String.raw`(raw) => [...raw.matchAll(/[^\s\-‐–—\/]+[\-‐–—\/]*|[\-‐–—\/]+/g)]
  .map((m) => ({ start: m.index, end: m.index + m[0].length }))`;

/**
 * Image formats that may be handed to pptxgenjs, recognised by their own bytes.
 *
 * pptxgenjs sizes images with `image-size`, whose ICNS, JXL and HEIF parsers
 * loop forever on a crafted buffer (CVE-2025-71329/71330) and would freeze the
 * main process. Checked by signature, not the `data:` media type, because
 * `image-size` sniffs content and ignores the label. SVG is text and safe.
 */
const IMAGE_SIGNATURES: ReadonlyArray<{ mime: string; bytes: number[] }> = [
  {
    mime: "image/png",
    bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  },
  { mime: "image/jpeg", bytes: [0xff, 0xd8, 0xff] },
  { mime: "image/gif", bytes: [0x47, 0x49, 0x46, 0x38] },
  // "RIFF", then four bytes of length, then "WEBP".
  { mime: "image/webp", bytes: [0x52, 0x49, 0x46, 0x46] },
];

/** The media type the bytes start with, or null for anything else. */
const sniff = (head: Uint8Array): string | null =>
  IMAGE_SIGNATURES.find(
    ({ mime, bytes }) =>
      bytes.every((byte, index) => head[index] === byte) &&
      // RIFF is a container: only the WebP flavour of it is an image.
      (mime !== "image/webp" ||
        Buffer.from(head.subarray(8, 12)).toString("ascii") === "WEBP")
  )?.mime ?? null;

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
    // 18 bytes covers every signature above, including WebP's "WEBP" at 8.
    head = Buffer.from(match[2].slice(0, 24), "base64");
  } catch {
    return false;
  }

  return sniff(head) != null;
}

/**
 * A slide's speaker notes (`<aside class="notes">`, or any `.notes`), read from
 * the markup: they are hidden on the slide, so the layout has no text for them.
 */
export const NOTES_OF = String.raw`(slide) => [...slide.querySelectorAll('.notes')]
    .map((n) => (n.textContent || '').replace(/\s+/g, ' ').trim())
    .filter(Boolean)
    .join('\n')`;

type SlideCapture = {
  width: number;
  height: number;
  background: string;
  boxes: Box[];
  runs: Run[];
  images: Picture[];
  charts: Drawing[];
  notes: string;
};

/** Bigger than this, a file picture only slows the .pptx down. */
const MAX_PICTURE_BYTES = 12 * 1024 * 1024;

/**
 * A picture the deck loaded from a file:// URL, as a data URI, or null when it
 * is not a file, cannot be read, or is not an image we can size (see
 * isSupportedImage). Showcase: the user's own photos were left out.
 */
export async function pictureFromFile(src: string): Promise<string | null> {
  if (!/^file:/i.test(src)) return null;
  try {
    const file = fileURLToPath(src);
    const stat = await fs.stat(file);
    if (!stat.isFile() || stat.size > MAX_PICTURE_BYTES) return null;
    const bytes = await fs.readFile(file);
    if (/\.svg$/i.test(file))
      return `data:image/svg+xml;base64,${bytes.toString("base64")}`;
    const mime = sniff(bytes);
    return mime == null
      ? null
      : `data:${mime};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}

/**
 * Runs inside the page, once per deck; everything it returns is measured by the
 * layout engine. A string because it is evaluated in the renderer.
 */
export const EXTRACT = String.raw`(() => {
  const slides = [...document.querySelectorAll('.slide')]
  const linesOf = ${LINES_OF}
  const wordPieces = ${WORD_PIECES}
  const notesOf = ${NOTES_OF}
  const gradientFill = ${GRADIENT_FILL}
  const slideBackground = ${SLIDE_BACKGROUND}
  const paint = (value) => {
    const m = /rgba?\(\s*(\d+)[,\s]+(\d+)[,\s]+(\d+)(?:[,\s/]+([\d.]+)(%?))?/i.exec(value || '')
    if (!m) return null
    let alpha = m[4] === undefined ? 1 : parseFloat(m[4])
    if (m[5] === '%') alpha /= 100
    if (alpha < 0.06) return null
    const hex = [m[1], m[2], m[3]].map((n) => Number(n).toString(16).padStart(2, '0')).join('').toUpperCase()
    return { hex, alpha }
  }
  const hex = (value) => (paint(value) || {}).hex || null
  // The opacity an element is drawn at: its own times every ancestor's up to the slide.
  const opacityOf = (el, slide) => {
    let o = 1
    for (let at = el; at && at !== slide.parentElement; at = at.parentElement) {
      o *= parseFloat(getComputedStyle(at).opacity)
      if (!(o >= 0)) return 1
    }
    return o
  }

  return slides.map((slide) => {
    const frame = slide.getBoundingClientRect()
    const style = getComputedStyle(slide)
    const boxes = []
    const rules = []
    const covering = []
    const runs = []
    const images = []

    // Painted areas: a solid background on any descendant is a shape in the result.
    // The slide's own background becomes the slide background instead.
    for (const el of [slide, ...slide.querySelectorAll('*')]) {
      const cs = getComputedStyle(el)
      if (cs.visibility === 'hidden' || cs.display === 'none' || parseFloat(cs.opacity) < 0.06) continue
      const r = el.getBoundingClientRect()
      if (r.width < 3 || r.height < 3) continue
      // Rules drawn as borders (a separator, an accent bar, a table's lines),
      // each side as a thin box, painted after the fills so none covers them.
      for (const side of ['Top', 'Right', 'Bottom', 'Left']) {
        const bw = parseFloat(cs['border' + side + 'Width']) || 0
        if (bw < 1 || cs['border' + side + 'Style'] === 'none' || cs['border' + side + 'Style'] === 'hidden') continue
        const bc = paint(cs['border' + side + 'Color'])
        if (bc == null) continue
        const a = bc.alpha * opacityOf(el, slide)
        if (a < 0.06) continue
        const x = r.left - frame.left, y = r.top - frame.top
        rules.push(
          side === 'Top' ? { x, y, w: r.width, h: bw, color: bc.hex, alpha: a, radius: 0 }
          : side === 'Bottom' ? { x, y: y + r.height - bw, w: r.width, h: bw, color: bc.hex, alpha: a, radius: 0 }
          : side === 'Left' ? { x, y, w: bw, h: r.height, color: bc.hex, alpha: a, radius: 0 }
          : { x: x + r.width - bw, y, w: bw, h: r.height, color: bc.hex, alpha: a, radius: 0 })
      }
      // A gradient has no background colour; its average colour stands in.
      const fill = paint(cs.backgroundColor) || paint(gradientFill(cs.backgroundImage))
      if (fill == null) continue
      const alpha = fill.alpha * opacityOf(el, slide)
      if (alpha < 0.06) continue
      // Full-slide fills are the background, not a box on top of it.
      if (r.width > frame.width * 0.98 && r.height > frame.height * 0.98) {
        if (alpha >= 0.5) covering.push(fill.hex)
        continue
      }
      boxes.push({
        x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height,
        color: fill.hex, alpha, radius: parseFloat(cs.borderTopLeftRadius) || 0,
      })
    }

    boxes.push(...rules)

    for (const img of slide.querySelectorAll('img')) {
      const r = img.getBoundingClientRect()
      if (r.width < 4 || r.height < 4) continue
      const src = img.currentSrc || img.src || ''
      const at = { x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height }
      if (src.startsWith('data:')) images.push({ ...at, data: src })
      else if (src.startsWith('file:')) images.push({ ...at, file: src })
    }

    // A chart (any outermost SVG) goes in as a picture of how it printed, its
    // labels with it; its text is not also placed as text boxes below.
    const charts = []
    for (const svg of slide.querySelectorAll('svg')) {
      if (svg.parentElement && svg.parentElement.closest('svg')) continue
      const cs = getComputedStyle(svg)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      const r = svg.getBoundingClientRect()
      if (r.width < 16 || r.height < 16) continue
      charts.push({
        x: r.left - frame.left, y: r.top - frame.top, w: r.width, h: r.height,
        pageX: r.left + window.scrollX, pageY: r.top + window.scrollY,
      })
    }

    // One run per drawn line of each text node, measured with a Range so the box
    // is the glyphs' own box rather than the block's. A heading in a tall
    // container would otherwise land at the top of the container instead of
    // where it is drawn.
    const blocks = new Map()
    const walker = document.createTreeWalker(slide, NodeFilter.SHOW_TEXT)
    let node
    while ((node = walker.nextNode())) {
      const raw = node.nodeValue || ''
      if (!raw.trim()) continue
      const parent = node.parentElement
      if (!parent) continue
      const cs = getComputedStyle(parent)
      if (cs.visibility === 'hidden' || cs.display === 'none') continue
      if (['SCRIPT', 'STYLE', 'NOSCRIPT'].includes(parent.tagName)) continue
      if (parent.closest('svg')) continue
      const color = paint(cs.color)
      if (color == null) continue
      const alpha = color.alpha * opacityOf(parent, slide)
      if (alpha < ${MIN_TEXT_ALPHA}) continue

      const words = []
      for (const piece of wordPieces(raw)) {
        const range = document.createRange()
        range.setStart(node, piece.start)
        range.setEnd(node, piece.end)
        const r = range.getBoundingClientRect()
        range.detach()
        if (r.width < 1 || r.height < 2) continue
        words.push({ ...piece, top: r.top, bottom: r.bottom, left: r.left, right: r.right })
      }

      const weight = parseInt(cs.fontWeight, 10)
      for (const line of linesOf(words)) {
        const text = raw.slice(line.start, line.end).replace(/\s+/g, ' ').trim()
        if (!text || line.right - line.left < 2) continue
        runs.push({
          text,
          x: line.left - frame.left, y: line.top - frame.top, w: line.right - line.left, h: line.bottom - line.top,
          size: parseFloat(cs.fontSize) || 12,
          color: color.hex,
          alpha,
          bold: Number.isFinite(weight) ? weight >= 600 : cs.fontWeight === 'bold',
          italic: cs.fontStyle === 'italic',
          align: ['center', 'right'].includes(cs.textAlign) ? cs.textAlign : 'left',
          font: (cs.fontFamily || '').split(',')[0].replace(/["']/g, '').trim(),
          transform: cs.textTransform,
          block: (() => {
            const el = parent.closest('h1, h2, h3, h4, h5, h6, p, li, td, th, figcaption, blockquote') || parent
            if (!blocks.has(el)) blocks.set(el, blocks.size)
            return blocks.get(el)
          })(),
        })
      }
    }

    return {
      width: frame.width,
      height: frame.height,
      background: slideBackground(hex(style.backgroundColor), covering, hex(getComputedStyle(document.body).backgroundColor)),
      boxes, runs, images, charts,
      notes: notesOf(slide),
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
  const { default: PptxGenJsImport } = await import("pptxgenjs");
  const PptxGenJs = ((PptxGenJsImport as unknown as { default?: unknown })
    .default ?? PptxGenJsImport) as new () => PptxInstance;
  const deck = new PptxGenJs();

  const page = slideSizeOf(captures);

  deck.defineLayout({ name: "DECK", width: page.width, height: page.height });
  deck.layout = "DECK";

  let written = 0;

  for (const capture of captures) {
    if (capture.width < 10 || capture.height < 10) continue;

    const scaleX = SLIDE_W / capture.width;
    const scaleY = page.height / capture.height;
    const slide = deck.addSlide();

    slide.background = { color: capture.background };
    if (capture.notes) slide.addNotes(capture.notes);

    for (const box of capture.boxes) {
      slide.addShape("rect", {
        x: box.x * scaleX,
        y: box.y * scaleY,
        w: box.w * scaleX,
        h: box.h * scaleY,
        fill: {
          color: box.color,
          ...(box.alpha < 0.99
            ? { transparency: transparencyOf(box.alpha) }
            : {}),
        },
        line: { type: "none" },
        ...(box.radius > 1
          ? { rectRadius: Math.min(0.2, box.radius * scaleX) }
          : {}),
      });
    }

    for (const image of capture.images) {
      // See isSupportedImage: an unsizeable format hangs the main process.
      if (image.data == null || !isSupportedImage(image.data)) continue;

      slide.addImage({
        data: image.data,
        x: image.x * scaleX,
        y: image.y * scaleY,
        w: image.w * scaleX,
        h: image.h * scaleY,
      });
    }

    const points = (run: Run): number =>
      Math.round(pointsFor(run.size, capture.width) * 10) / 10;
    const textOf = (run: Run): string =>
      textFor(run.text, run.font, run.transform);
    // Where each line goes, and the scale it alone would need (see below).
    const placed = lineGroups(capture.runs)
      .filter((group) => !group.every((run) => points(run) < MIN_PT))
      .map((group) => {
        const first = group[0]!;
        const last = group[group.length - 1]!;
        const width = (last.x + last.w - first.x) * scaleX;
        const slack = 0.35;
        const left =
          first.align === "right"
            ? first.x * scaleX - slack
            : first.align === "center"
              ? first.x * scaleX - slack / 2
              : first.x * scaleX;
        const box = Math.min(SLIDE_W - Math.max(0, left), width + slack);
        const lead = group.reduce((a, b) => (b.size > a.size ? b : a));
        const scale =
          displayPoints(
            points(lead),
            group.map(textOf).join(" "),
            faceFor(lead.font, group.map(textOf).join(" ")),
            lead.bold,
            box
          ) / points(lead);
        return { group, left, box, scale, block: lead.block ?? -1 };
      });
    // A heading's lines share one scale (live chat u01: its first line
    // printed smaller than the next two).
    const scales = sharedScales(
      placed.map((p) => p.scale),
      placed.map((p) => p.block)
    );

    for (const [index, { group, left, box }] of placed.entries()) {
      const first = group[0]!;
      const scale = scales[index]!;

      // One drawn line, placed where the browser drew it (see LINES_OF), its
      // runs as styled segments of one box so a wider face pushes them along
      // instead of into each other. Its alignment decides where the slack goes.
      // Last resort for a display line still wider in its common face than
      // its box: one scale for the whole line, by at most a fifth.
      const segments = group.map((run, at) => {
        const text = textOf(run);
        const previous = group[at - 1];
        // The space between two runs is in neither run's text.
        const spaced =
          previous != null &&
          run.x - (previous.x + previous.w) > run.size * 0.15
            ? ` ${text}`
            : text;

        return {
          text: spaced,
          options: {
            fontSize: Math.round(points(run) * scale * 10) / 10,
            color: run.color,
            ...(run.alpha < 0.99
              ? { transparency: transparencyOf(run.alpha) }
              : {}),
            bold: run.bold,
            italic: run.italic,
            // A common face the viewer has (see faceFor), not the web font.
            fontFace: faceFor(run.font, spaced),
          },
        };
      });

      slide.addText(segments as never, {
        x: Math.max(0, left),
        // Nudged up: a PowerPoint text box adds leading above the glyphs that a
        // Range's box does not have.
        y: Math.max(0, Math.min(...group.map((run) => run.y)) * scaleY - 0.03),
        // Slack for a slightly wider face; the line itself never wraps.
        w: box,
        h: Math.max(...group.map((run) => run.h)) * scaleY + 0.12,
        align: first.align,
        valign: "top",
        margin: 0,
        // Shrinking or wrapping would move text off where the design put it.
        shrinkText: false,
        fit: "none",
        wrap: false,
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
 * Some templates hide [data-anim] text until its slide is the active one on
 * screen. Neither a printed page nor a measured one has an active slide, so
 * both the print styles and the .pptx capture show it with this rule.
 */
export const SHOW_ANIMATED_TEXT = `
  [data-anim] {
    opacity: 1 !important;
    animation: none !important;
  }`;

/**
 * Makes the page measurable before capturing it: `deck-stage` scales the deck
 * to fit the window and hides every non-active slide, so an unprepared capture
 * measures every slide at 0x0. The capture runs on screen, where the print
 * styles do not apply, so the animated-text rule is added here too.
 */
export const prepareScript = (
  widthPx: number,
  heightPx: number
): string => String.raw`(async () => {
  const stage = document.querySelector('deck-stage')
  const slides = [...document.querySelectorAll('.slide')]
  // The size the deck printed at: a template sized to its window prints at
  // the window's size, and measured at any other its content sits elsewhere.
  const w = Number(stage && stage.getAttribute('width')) || ${widthPx}
  const h = Number(stage && stage.getAttribute('height')) || ${heightPx}

  if (!document.querySelector('style[data-deck-pptx]')) {
    const shown = document.createElement('style')
    shown.setAttribute('data-deck-pptx', '')
    shown.textContent = ${JSON.stringify(SHOW_ANIMATED_TEXT)}
    document.head.appendChild(shown)
  }

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
      // The slide's own display (grid, flex) is its layout: forced to block,
      // storefront's two-column cover printed its title across the slide.
      // One the template hides until shown gets its own 'active' classes.
      if (getComputedStyle(slide).display === 'none') slide.classList.add('active', 'is-active')
      if (getComputedStyle(slide).display === 'none') slide.style.setProperty('display', 'block', 'important')
      slide.style.setProperty('width', w + 'px', 'important')
      slide.style.setProperty('height', h + 'px', 'important')
      slide.style.setProperty('visibility', 'visible', 'important')
      slide.style.setProperty('opacity', '1', 'important')
    }
  }

  // Two frames: one for the attributes and styles to apply, one for layout to
  // settle at the new size before anything is measured.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))

  // Fades and transitions jump to their end: coral fades a shown slide in
  // over 0.6s, and measured mid-fade its text was all but transparent.
  if (typeof document.getAnimations === 'function') {
    for (const animation of document.getAnimations()) {
      try { animation.finish() } catch { /* an infinite one cannot finish */ }
    }
  }

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
 * A chart (or any region of the page) as it printed, as a PNG data URI: scrolled into view and shot from
 * the window (the debugger's beyond-the-viewport shot closed the target in a
 * hidden window). Null when it cannot be shot.
 */
export const shootRegion = async (
  win: BrowserWindow,
  chart: Pick<Drawing, "pageX" | "pageY" | "w" | "h">
): Promise<string | null> => {
  try {
    const scrolled = (await win.webContents.executeJavaScript(
      `(async () => { window.scrollTo(${Math.round(chart.pageX)}, ${Math.round(chart.pageY)}); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); return [window.scrollX, window.scrollY] })()`,
      true
    )) as [number, number];
    const image = await win.webContents.capturePage({
      x: Math.round(chart.pageX - scrolled[0]),
      y: Math.round(chart.pageY - scrolled[1]),
      width: Math.round(chart.w),
      height: Math.round(chart.h),
    });
    if (image.isEmpty()) return null;
    return `data:image/png;base64,${image.toPNG().toString("base64")}`;
  } catch {
    return null;
  }
};

/**
 * Measures the page laid out for print, as the PDF was. On screen a template
 * sizes its slides to the window and centres nothing the print styles centre,
 * so a screen capture put titles near the top of every slide. Print media
 * brings in the same page boxes, fitted text and shown animated text.
 */
const measuredAsPrinted = async (
  win: BrowserWindow,
  size: { widthPx: number; heightPx: number }
): Promise<SlideCapture[]> => {
  const tools = win.webContents.debugger;
  const attached = !tools.isAttached();

  if (attached) tools.attach("1.3");

  try {
    await tools.sendCommand("Emulation.setEmulatedMedia", { media: "print" });
    await win.webContents.executeJavaScript(
      prepareScript(size.widthPx, size.heightPx),
      true
    );

    const captures = (await win.webContents.executeJavaScript(
      EXTRACT,
      true
    )) as SlideCapture[];
    // Pictures: a file the page loaded is read here; a chart is shot as it
    // printed.
    for (const capture of Array.isArray(captures) ? captures : []) {
      const images: Picture[] = [];
      for (const image of capture.images ?? []) {
        if (image.file == null) {
          images.push(image);
          continue;
        }
        const data = await pictureFromFile(image.file);
        if (data != null) images.push({ ...image, data });
      }
      for (const chart of capture.charts ?? []) {
        const data = await shootRegion(win, chart);
        if (data != null)
          images.push({ x: chart.x, y: chart.y, w: chart.w, h: chart.h, data });
      }
      capture.images = images;
    }
    return captures;
  } finally {
    await tools
      .sendCommand("Emulation.setEmulatedMedia", { media: "" })
      .catch(() => {});
    if (attached) tools.detach();
  }
};

/**
 * Exports the deck loaded in `win` as an editable .pptx. Called after the PDF
 * is printed from the same window, so a failure here cannot cost the PDF.
 */
export const exportDeckPptx = async (
  win: BrowserWindow,
  pdfPath: string,
  size: { widthPx: number; heightPx: number }
): Promise<DeckPptxResult> => {
  const captures = await measuredAsPrinted(win, size);

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
