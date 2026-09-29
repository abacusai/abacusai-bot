/**
 * The deck component behind the `ppt` tool. The model picks a template and
 * writes the words; this harness does everything that must be exact (reading,
 * splicing, assembling, exporting), so the ~48 KB templates never enter a
 * conversation and a model that cannot touch the HTML cannot break the deck.
 */
import fs from "fs/promises";
import path from "path";

import { resourcePath } from "#main/resources";

import { exportDeckPdf } from "./deck-pdf";

const MAX_SLIDES = 20;

/** Templates ship 8-18 demo slides (a catalogue); five is what gets presented. */
const DEFAULT_SLIDES = 5;

export type DeckRequest = {
  /** What the deck is about: the brief, in the caller's words. */
  context: string;
  /** Where the finished PDF goes. */
  outputPath: string;
  /** Overrides the model's own choice of template. */
  template?: string;
  /** Target slide count. Defaults to five. */
  slides?: number;
};

export type DeckResult = {
  pdfPath: string;
  htmlPath: string;
  template: string;
  templateName: string;
  rationale: string;
  slides: number;
  model: string;
  seconds: number;
};

type TemplateIndexEntry = {
  slug: string;
  name: string;
  tagline: string;
  mood?: string[];
  tone?: string[];
  formality?: string;
  scheme?: string;
  best_for?: string;
  slide_count?: number;
};

const decksDir = async (): Promise<string> => {
  const dir = resourcePath("decks");
  const present = await fs
    .stat(path.join(dir, "templates.json"))
    .then(() => true)
    .catch(() => false);

  if (!present) {
    throw new Error("The bundled deck templates are missing from this build.");
  }

  return dir;
};

/** `gaps[i]` is the markup between slide i and slide i+1, kept for reassembly. */
type SplitDeck = {
  head: string;
  slides: string[];
  gaps: string[];
  tail: string;
};

/** Class-list check: `class="slide-header"` must not match `slide`. */
const hasSlideClass = (openTag: string): boolean => {
  const classAttr = /\bclass\s*=\s*"([^"]*)"/.exec(openTag)?.[1] ?? "";
  return classAttr.split(/\s+/).includes("slide");
};

/**
 * Slides are found by class and closed by counting depth of the same tag
 * name: a `<div class="slide">` holds more divs, so a regex cannot split it.
 */
const splitTemplate = (html: string): SplitDeck => {
  const opening = /<(section|div|article)\b[^>]*>/gi;
  const slides: string[] = [];
  const gaps: string[] = [];
  let firstStart = -1;
  let lastEnd = -1;
  let match: RegExpExecArray | null;

  while ((match = opening.exec(html)) != null) {
    if (!hasSlideClass(match[0])) continue;

    const tag = match[1].toLowerCase();
    const start = match.index;
    const scanner = new RegExp(`<${tag}\\b[^>]*>|</${tag}\\s*>`, "gi");
    scanner.lastIndex = start;
    let depth = 0;
    let end = -1;
    let step: RegExpExecArray | null;
    while ((step = scanner.exec(html)) != null) {
      depth += step[0].startsWith("</") ? -1 : 1;
      if (depth === 0) {
        end = step.index + step[0].length;
        break;
      }
    }
    if (end < 0) continue;

    if (firstStart >= 0) gaps.push(html.slice(lastEnd, start));
    slides.push(html.slice(start, end));
    if (firstStart < 0) firstStart = start;
    lastEnd = end;
    // Skip past this slide so its nested elements are not read as slides.
    opening.lastIndex = end;
  }

  if (slides.length === 0)
    return { head: html, slides: [], gaps: [], tail: "" };
  return {
    head: html.slice(0, firstStart),
    slides,
    gaps,
    tail: html.slice(lastEnd),
  };
};

// Text slots: how a slide is filled without anyone seeing its markup.

/**
 * One piece of visible text in a slide, addressable by id. The caller sees and
 * answers with strings; only the text between tags is ever substituted. `tag`
 * and `chars` tell a filler whether a string is a heading or a caption and how
 * much room it has, so it does not write a paragraph where a label goes.
 */
export type SlideSlot = {
  id: string;
  tag: string;
  text: string;
  chars: number;
};

export type DeckSlideSlots = {
  index: number;
  /** The template's own name for this slide's role, when it declares one. */
  label: string;
  slots: SlideSlot[];
};

/** Elements whose text is not content: scripts, styles, and icon internals. */
const OPAQUE_ELEMENTS = new Set(["script", "style", "svg"]);

/**
 * Yields the text between a slide's tags. One traversal serves both reading
 * and writing slots, so the two cannot disagree about which text is slot 3.
 */
const eachTextNode = (
  slide: string,
  visit: (
    text: string,
    start: number,
    end: number,
    enclosing: string,
    ordinal: number
  ) => void
): void => {
  const tags = /<[^>]+>/g;
  let cursor = 0;
  let enclosing = "";
  let opaque = 0;
  let ordinal = 0;
  let match: RegExpExecArray | null;

  while ((match = tags.exec(slide)) != null) {
    const between = slide.slice(cursor, match.index);

    if (opaque === 0 && between.trim().length > 0)
      visit(between, cursor, match.index, enclosing, ++ordinal);

    const tag = match[0];
    const name = (/^<\/?([a-zA-Z][\w-]*)/.exec(tag)?.[1] ?? "").toLowerCase();
    const closing = tag.startsWith("</");
    const selfClosing = tag.endsWith("/>");

    if (OPAQUE_ELEMENTS.has(name)) {
      if (closing) opaque = Math.max(0, opaque - 1);
      else if (!selfClosing) opaque += 1;
    }

    if (!closing && !selfClosing) enclosing = name;

    cursor = match.index + tag.length;
  }
};

const escapeHtmlText = (value: string): string =>
  value.replace(
    /[&<>]/g,
    (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[ch] ?? ch
  );

/**
 * Decoded on the way out, escaped on the way in: an example reading `&amp;`
 * invites a filler to answer in entities, which would print literally.
 */
const decodeHtmlText = (value: string): string =>
  value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&nbsp;/g, " ")
    // Ampersand last, so `&amp;lt;` does not become a tag.
    .replace(/&amp;/g, "&");

const slotsOf = (slide: string): SlideSlot[] => {
  const slots: SlideSlot[] = [];

  eachTextNode(slide, (text, _start, _end, enclosing, ordinal) => {
    const trimmed = decodeHtmlText(text.trim());
    slots.push({
      id: `t${ordinal}`,
      tag: enclosing || "text",
      text: trimmed,
      chars: trimmed.length,
    });
  });

  return slots;
};

/**
 * Substitutes text into a slide, leaving every tag untouched. A skipped slot
 * keeps the template's text: a blank label is worse than a wrong one.
 * Replacements are escaped, since a stray `<` would close a tag.
 */
const fillSlots = (slide: string, values: Record<string, string>): string => {
  const edits: Array<{ start: number; end: number; text: string }> = [];

  eachTextNode(slide, (text, start, end, _enclosing, ordinal) => {
    const replacement = values[`t${ordinal}`];

    if (typeof replacement !== "string" || replacement.trim().length === 0)
      return;

    // Only the trimmed span is replaced; the whitespace is the indentation.
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;

    edits.push({
      start: start + leading,
      end: end - trailing,
      text: escapeHtmlText(replacement.trim()),
    });
  });

  let out = slide;

  // Back to front, so an earlier edit cannot shift a later one's offsets.
  for (const edit of edits.reverse())
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);

  return out;
};

/**
 * A model-chosen output path may point at a file the user already has. Our own
 * previous output is recognised by the sibling source directory AND the marker
 * file inside it, since the directory name alone could be a coincidence;
 * anything else is refused rather than silently replaced.
 */
const refuseForeignOverwrite = async (
  pdfPath: string,
  sourceDir: string,
  marker: string
): Promise<void> => {
  const exists = await fs
    .stat(pdfPath)
    .then((s) => s.isFile())
    .catch(() => false);
  if (!exists) return;
  const ours = await fs
    .stat(path.join(sourceDir, marker))
    .then((s) => s.isFile())
    .catch(() => false);
  if (ours) return;
  throw new Error(
    `${pdfPath} already exists and was not written by this tool. Choose a new output_path.`
  );
};

export type DeckTemplateSummary = {
  slug: string;
  name?: string;
  best_for?: string;
  mood?: string;
  tone?: string;
  formality?: string;
};

/** The catalogue minus the markup: a chooser needs the feel, not the HTML. */
export const deckTemplates = async (): Promise<{
  templates: DeckTemplateSummary[];
}> => {
  const skillDir = await decksDir();
  const index = JSON.parse(
    await fs.readFile(path.join(skillDir, "templates.json"), "utf8")
  ) as {
    templates: Array<Record<string, unknown>>;
  };

  return {
    templates: index.templates.map((entry) => ({
      slug: String(entry.slug ?? ""),
      ...(entry.name != null ? { name: String(entry.name) } : {}),
      ...(entry.best_for != null ? { best_for: String(entry.best_for) } : {}),
      ...(entry.mood != null ? { mood: String(entry.mood) } : {}),
      ...(entry.tone != null ? { tone: String(entry.tone) } : {}),
      ...(entry.formality != null
        ? { formality: String(entry.formality) }
        : {}),
    })),
  };
};

const loadTemplate = async (
  slug: string
): Promise<{ dir: string; split: SplitDeck }> => {
  const skillDir = await decksDir();
  const index = JSON.parse(
    await fs.readFile(path.join(skillDir, "templates.json"), "utf8")
  ) as {
    templates: TemplateIndexEntry[];
  };

  if (!index.templates.some((entry) => entry.slug === slug))
    throw new Error(`No such deck template: ${slug}`);

  const dir = path.join(skillDir, "templates", slug);
  const split = splitTemplate(
    await fs.readFile(path.join(dir, "template.html"), "utf8")
  );

  if (split.slides.length === 0)
    throw new Error(`Template ${slug} has no slides.`);

  return { dir, split };
};

export type DeckSlotsRequest = { template: string; slides?: number };

/** The text a template's slides contain, slot by slot. See `SlideSlot`. */
export const deckSlots = async (
  request: DeckSlotsRequest
): Promise<{
  template: string;
  available: number;
  slides: DeckSlideSlots[];
}> => {
  const { split } = await loadTemplate(request.template);
  const wanted = Math.max(
    1,
    Math.min(request.slides ?? DEFAULT_SLIDES, split.slides.length, MAX_SLIDES)
  );

  return {
    template: request.template,
    available: split.slides.length,
    slides: split.slides.slice(0, wanted).map((slide, index) => ({
      index: index + 1,
      label: /data-label="([^"]*)"/.exec(slide)?.[1] ?? `slide ${index + 1}`,
      slots: slotsOf(slide),
    })),
  };
};

export type RenderDeckRequest = {
  template: string;
  outputPath: string;
  /** Per slide, replacement text keyed by the slot ids from `deckSlots`. */
  slides: Array<{ index: number; values: Record<string, string> }>;
};

export type RenderDeckResult = {
  pdfPath: string;
  htmlPath: string;
  /** Editable deck built from the same text, or null if it could not be written. */
  pptxPath: string | null;
  pptxError?: string | null;
  template: string;
  slides: number;
  seconds: number;
};

/**
 * Assembles the deck from filled slots and prints it. An unfilled slot keeps
 * the template's text, so a partial answer still produces a whole deck.
 */
export const renderDeck = async (
  request: RenderDeckRequest
): Promise<RenderDeckResult> => {
  const startedAt = Date.now();

  const outputPath = path.resolve(request.outputPath);
  const outputDir = path.dirname(outputPath);
  const deckDir = path.join(
    outputDir,
    `${path.basename(outputPath).replace(/\.[^./\\]+$/, "")}-deck`
  );
  const pdfPath = outputPath.toLowerCase().endsWith(".pdf")
    ? outputPath
    : `${outputPath.replace(/\.[^./\\]+$/, "")}.pdf`;
  await refuseForeignOverwrite(pdfPath, deckDir, "deck.html");

  const { dir: templateDir, split } = await loadTemplate(request.template);
  const { head, slides: sections, gaps, tail } = split;

  const byIndex = new Map(
    request.slides.map((slide) => [slide.index, slide.values])
  );
  const wanted = Math.max(
    1,
    Math.min(request.slides.length, sections.length, MAX_SLIDES)
  );
  const filled = sections
    .slice(0, wanted)
    .map((section, index) => fillSlots(section, byIndex.get(index + 1) ?? {}));

  await fs.mkdir(deckDir, { recursive: true });

  for (const asset of await fs.readdir(templateDir)) {
    if (
      asset === "template.html" ||
      asset === "design.md" ||
      asset === "template.json"
    )
      continue;
    await fs.copyFile(path.join(templateDir, asset), path.join(deckDir, asset));
  }

  // Templates carry demo speaker notes; stale notes are worse than none.
  const withoutNotes = (html: string): string =>
    html
      .replace(/<script[^>]*id="speaker-notes"[\s\S]*?<\/script>/gi, "")
      .replace(
        /<aside\b[^>]*class="[^"]*\bnotes\b[^"]*"[\s\S]*?<\/aside>/gi,
        ""
      );

  const escapeAttr = (value: string): string =>
    value.replace(
      /[&<>"]/g,
      (ch) =>
        ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch
    );

  /** The template's <title> is its name; the first heading is the real one. */
  const retitle = (html: string): string => {
    const heading =
      /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(filled[0] ?? "")?.[1] ?? "";
    const title = heading
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim();

    return title.length === 0
      ? html
      : html.replace(
          /<title>[\s\S]*?<\/title>/i,
          `<title>${escapeAttr(title)}</title>`
        );
  };

  const body = filled
    .map((section, i) =>
      i < filled.length - 1 ? section + (gaps[i] ?? "\n") : section
    )
    .join("");
  const htmlPath = path.join(deckDir, "deck.html");
  await fs.writeFile(
    htmlPath,
    retitle(withoutNotes(head + body + tail)),
    "utf8"
  );

  // The HTML is openable by now, so a failed export says where it is.
  const exported = await exportDeckPdf({ htmlPath, outputPath: pdfPath }).catch(
    (error: unknown) => {
      throw new Error(
        `the slides were written to ${htmlPath} but the PDF export failed: ${(error as Error)?.message ?? "unknown error"}`
      );
    }
  );

  return {
    pdfPath: exported.pdfPath,
    htmlPath,
    pptxPath: exported.pptxPath,
    pptxError: exported.pptxError ?? null,
    template: request.template,
    slides: exported.slides,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
};
