/**
 * The deck component behind the `ppt` tool. The model picks a template and
 * writes the words; this harness does everything that must be exact (reading,
 * splicing, assembling, exporting), so the ~48 KB templates never enter a
 * conversation and a model that cannot touch the HTML cannot break the deck.
 */
import fs from "fs/promises";
import path from "path";

import { modelPath } from "@abacus-ai/agent/model-path";

import { resourcePath } from "#main/resources";

import { exportDeckPdf } from "./deck-pdf";
import { unsupportedNumbers } from "./docs-system/faithful";

const MAX_SLIDES = 20;

/** Templates ship 8-18 demo slides (a catalogue); five is what gets presented. */
const DEFAULT_SLIDES = 5;

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

type SplitDeck = {
  head: string;
  slides: string[];
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
export const splitTemplate = (html: string): SplitDeck => {
  const opening = /<(section|div|article)\b[^>]*>/gi;
  const slides: string[] = [];
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

    slides.push(html.slice(start, end));
    if (firstStart < 0) firstStart = start;
    lastEnd = end;
    // Skip past this slide so its nested elements are not read as slides.
    opening.lastIndex = end;
  }

  if (slides.length === 0) return { head: html, slides: [], tail: "" };
  return {
    head: html.slice(0, firstStart),
    slides,
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
const safeChar = (code: number, whole: string): string =>
  Number.isInteger(code) && code > 0 && code <= 0x10ffff
    ? String.fromCodePoint(code)
    : whole;

/** Named entities templates and fillers use; anything else is left as written. */
const NAMED_ENTITIES: Record<string, string> = {
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  middot: "·",
  bull: "•",
  mdash: "—",
  ndash: "–",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  uarr: "↑",
  darr: "↓",
  larr: "←",
  rarr: "→",
  times: "×",
  divide: "÷",
  plusmn: "±",
  minus: "−",
  deg: "°",
  pound: "£",
  euro: "€",
  yen: "¥",
  cent: "¢",
  copy: "©",
  reg: "®",
  trade: "™",
  sect: "§",
  para: "¶",
  frac12: "½",
  frac14: "¼",
  frac34: "¾",
};

const decodeHtmlText = (value: string): string =>
  value
    .replace(/&#(\d+);/g, (whole, digits: string) =>
      safeChar(Number(digits), whole)
    )
    .replace(/&#x([0-9a-f]+);/gi, (whole, hex: string) =>
      safeChar(Number.parseInt(hex, 16), whole)
    )
    .replace(
      /&([a-z][a-z0-9]*);/gi,
      (whole, name: string) => NAMED_ENTITIES[name] ?? whole
    )
    // Ampersand last, so `&amp;lt;` does not become a tag.
    .replace(/&amp;/g, "&");

/**
 * A slide's own number written into it as text ("03 / 18"): the second figure
 * is the template's slide count, which tells it from a figure such as "4 / 5".
 */
const PAGE_NUMBER = /^(\d{1,3})(\s*(?:\/|of)\s*)(\d{1,3})$/;

const isPageNumber = (text: string, templateSlides: number): boolean => {
  const match = PAGE_NUMBER.exec(text.trim());
  return match != null && Number(match[3]) === templateSlides;
};

const slotsOf = (slide: string, templateSlides: number): SlideSlot[] => {
  const slots: SlideSlot[] = [];

  eachTextNode(slide, (text, _start, _end, enclosing, ordinal) => {
    // Numbered in code once the slides are picked, not by the filler.
    if (isPageNumber(text, templateSlides)) return;
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

/** What the filler sends for a slot to drop; see dropRemoved. */
const REMOVE_SLOT = "[remove]";
/** A marked label's stand-in while dropped slots are swept (see dropRemoved). */
const LABEL_TOKEN = /\u2064\d+\u2065/g;
/** An empty decoration element's stand-in while dropped slots are swept. */
const DECOR_TOKEN = /\u2066\d+\u2067/g;
/** Stands in for a dropped slot until its element is gone (invisible). */
const REMOVED_MARK = "\u2063";

/**
 * Takes out what the filler dropped: an element whose only text is dropped
 * slots goes (a card, a table row, a list item), and its parent goes too when
 * nothing else in it has text. Decoration with no text is never touched, and
 * table cells stay so a row keeps its columns.
 */
export const dropRemoved = (slide0: string): string => {
  if (!slide0.includes(REMOVED_MARK)) return slide0;
  // A cell a template marks data-deck-keep holds a grid's place: emptied, not
  // removed. A timeline's dropped years shifted every later cell of its
  // date | spine | content grid and the slide collapsed (hard asks).
  const slide = slide0.replace(
    /<([a-z][\w-]*)\b[^>]*\bdata-deck-keep\b[^>]*>[\s\S]*?<\/\1>/gi,
    (cell) => cell.split(REMOVED_MARK).join("")
  );
  if (!slide.includes(REMOVED_MARK)) return slide;
  const textOf = (html: string): string => {
    // Strip tags until none is left, so a tag split by another is gone too.
    let text = html;
    for (let last = ""; last !== text;) {
      last = text;
      text = text.replace(/<[^>]*>/g, "");
    }
    return text.replace(/\s+/g, "");
  };
  const innermost =
    /<(tr|li|div|article|p|h[1-6]|span|small|strong|em|b|a|button)\b[^>]*>((?:(?!<\/?\1\b)[\s\S])*?)<\/\1>/gi;
  // A kept element's inside is looked at too: matched first, an outer
  // element would hide an emptied link or item within it from this pass.
  const sweep = (html: string): string =>
    html.replace(innermost, (whole, tag: string, inner: string) => {
      const text = textOf(inner);
      if (!text.includes(REMOVED_MARK)) return whole;
      // A marked label ("Email") does not keep its block: it names a value.
      const left = text
        .replace(LABEL_TOKEN, "")
        .replace(DECOR_TOKEN, "")
        .split(REMOVED_MARK)
        .join("");
      // Nothing left, or only the item's own number ("05", "3."): an
      // emptied list item kept printing its numeral.
      if (left.length === 0 || /^0?\d{1,2}[.)]?$/.test(left))
        return REMOVED_MARK;
      const open = whole.slice(0, whole.length - inner.length - tag.length - 3);
      return `${open}${sweep(inner)}</${tag}>`;
    });
  // Labels become tokens first: a <div> label inside a <div> block would
  // otherwise hide the block from the innermost-element match.
  const labels: string[] = [];
  let out = slide.replace(
    /<([a-z][\w-]*)\b[^>]*\bdata-deck-label\b[^>]*>[\s\S]*?<\/\1>/gi,
    (label) => {
      labels.push(label);
      return `\u2064${labels.length - 1}\u2065`;
    }
  );
  // Empty decoration (a number box, a colour strip) becomes a token too: a
  // text-less <div> inside a card hid the card from the innermost match, so
  // a dropped card stayed on the slide with its numeral (retired templates).
  const decor: string[] = [];
  out = out.replace(
    /<(div|span|i|b|em|strong|small)\b[^>]*>\s*<\/\1>/gi,
    (empty) => {
      decor.push(empty);
      return `\u2066${decor.length - 1}\u2067`;
    }
  );
  for (let pass = 0; pass < 12; pass++) {
    const next = sweep(out);
    if (next === out) break;
    out = next;
  }
  return out
    .split(REMOVED_MARK)
    .join("")
    .replace(
      /\u2066(\d+)\u2067/g,
      (_, index: string) => decor[Number(index)] ?? ""
    )
    .replace(
      /\u2064(\d+)\u2065/g,
      (_, index: string) => labels[Number(index)] ?? ""
    );
};

/**
 * Substitutes text into a slide, leaving every tag untouched. A skipped slot
 * keeps the template's text: a blank label is worse than a wrong one.
 * Replacements are escaped, since a stray `<` would close a tag.
 */
export const fillSlots = (
  slide: string,
  values: Record<string, string>
): string => {
  const edits: Array<{ start: number; end: number; text: string }> = [];

  eachTextNode(slide, (text, start, end, enclosing, ordinal) => {
    const given = values[`t${ordinal}`];
    // A list item draws its own marker; a number typed in front of it prints
    // twice ("• 1. Evaporation."). "1.5 million" is a figure, not a marker.
    const replacement =
      enclosing === "li" && typeof given === "string"
        ? given.replace(/^\s*\d{1,2}[.)]\s+/, "")
        : given;

    if (typeof replacement !== "string" || replacement.trim().length === 0)
      return;
    const removed = replacement.trim() === REMOVE_SLOT;

    // Only the trimmed span is replaced; the whitespace is the indentation.
    const leading = text.length - text.trimStart().length;
    const trailing = text.length - text.trimEnd().length;

    edits.push({
      start: start + leading,
      end: end - trailing,
      // Decoded first: a filler that writes "&amp;" means "&", and escaping
      // it as written printed "&amp;amp;" as "&amp;".
      text: removed
        ? REMOVED_MARK
        : escapeHtmlText(decodeHtmlText(replacement.trim())),
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
    `${modelPath(pdfPath)} already exists and was not written by this tool. Choose a new output_path.`
  );
};

export type DeckTemplateSummary = {
  slug: string;
  name?: string;
  best_for?: string;
  avoid_for?: string;
  mood?: string;
  tone?: string;
  formality?: string;
  slide_count?: number;
  max_items?: number;
  colours?: string;
};

const LIST_WORDS: Record<string, number> = {
  two: 2,
  three: 3,
  four: 4,
  five: 5,
  six: 6,
  seven: 7,
  eight: 8,
  nine: 9,
  ten: 10,
  eleven: 11,
  twelve: 12,
};
/** The most items a slide's label says it holds ("up to eight sections", "four cards"). */
const listSize = (label: string): number => {
  let most = 0;
  for (const m of label.matchAll(
    /\b(two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d{1,2})(?:\s+|-)(?:[\w-]+\s+)?(points|items|cards|steps?|columns|findings|rules|reasons|tips|sections|rows|tiles|boxes|panels|features|ideas|lessons|events|sessions|people|members|questions)\b/gi
  )) {
    const word = m[1]!.toLowerCase();
    most = Math.max(most, LIST_WORDS[word] ?? Number(word));
  }
  return most;
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

  const offeredOf = new Map<
    string,
    { slide_count: number; max_items?: number; colours?: string }
  >();
  for (const entry of index.templates) {
    const slug = String(entry.slug ?? "");
    const html = await fs
      .readFile(path.join(skillDir, "templates", slug, "template.html"), "utf8")
      .catch(() => null);
    if (html == null) continue;
    const offered = splitTemplate(html).slides.filter(isOffered);
    const most = Math.max(
      0,
      ...offered.map((slide) =>
        listSize(/data-label="([^"]*)"/.exec(slide)?.[1] ?? "")
      )
    );
    // Its colours in words, so "make it green" finds a green template.
    const colours = await fs
      .readFile(path.join(skillDir, "templates", slug, "template.json"), "utf8")
      .then((text) => {
        const palette = (
          JSON.parse(text) as { palette?: { description?: unknown } }
        ).palette;
        return typeof palette?.description === "string"
          ? palette.description
          : undefined;
      })
      .catch(() => undefined);
    offeredOf.set(slug, {
      ...(colours != null ? { colours } : {}),
      slide_count: Math.min(offered.length, MAX_SLIDES),
      ...(most > 0 ? { max_items: most } : {}),
    });
  }

  return {
    templates: index.templates.map((entry) => ({
      slug: String(entry.slug ?? ""),
      ...(entry.name != null ? { name: String(entry.name) } : {}),
      ...(entry.best_for != null ? { best_for: String(entry.best_for) } : {}),
      // What it is wrong for, too: without it monochrome kept being picked
      // for a student project.
      ...(entry.avoid_for != null
        ? { avoid_for: String(entry.avoid_for) }
        : {}),
      ...(entry.mood != null ? { mood: String(entry.mood) } : {}),
      // How many slides the filler is offered (a 15-slide ask got a 6-slide
      // template; broadside lists 16 and offers 13), and the longest list a
      // slide holds ("contents list of up to eight sections").
      ...offeredOf.get(String(entry.slug ?? "")),
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
    templates: Array<{ slug: string }>;
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

/**
 * Whether the filler is offered a slide. A template marks a slide
 * `data-deck-skip` when it needs what a brief does not give: a photo (else a
 * grey placeholder prints) or a chart's data (else the sample chart prints).
 */
export const isOffered = (slide: string): boolean =>
  !/^<[^>]*\sdata-deck-skip\b/.test(slide.trimStart());

/**
 * What a slide is for, as the filler reads it: the template's own
 * `data-label`, or else its first heading and how many text slots it has, so
 * "a stats slide with 4 figures" can be told from "the closing slide" without
 * seeing the markup.
 */
export const slideLabel = (
  slide: string,
  index: number,
  templateSlides: number
): string => {
  const declared = /data-label="([^"]*)"/.exec(slide)?.[1];
  if (declared != null && declared.trim().length > 0) return declared.trim();
  const heading = /<h[1-3]\b[^>]*>([\s\S]*?)<\/h[1-3]>/i.exec(slide)?.[1] ?? "";
  const text = decodeHtmlText(heading.replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
  const slots = slotsOf(slide, templateSlides).length;
  return `slide ${index}${text.length > 0 ? `: "${text.slice(0, 60)}"` : ""} (${slots} text slot${slots === 1 ? "" : "s"})`;
};

/**
 * The chosen slides, each filled, in index order: any of the template's
 * slides, not only its first few, so a short deck can still end on the
 * template's closing slide and skip a layout the content cannot fill.
 * Duplicates and indices past the template are dropped.
 */
export const pickSlides = (
  sections: readonly string[],
  chosen: ReadonlyArray<{ index: number; values: Record<string, string> }>,
  fill: (section: string, values: Record<string, string>) => string,
  max: number
): string[] => {
  const seen = new Set<number>();
  return (
    [...chosen]
      .filter(
        (slide) =>
          Number.isInteger(slide.index) &&
          slide.index >= 1 &&
          slide.index <= sections.length &&
          !seen.has(slide.index) &&
          seen.add(slide.index)
      )
      // In the filler's order, the story's (live: a museum deck came back with
      // the budget before "what we hold", and the bot rebuilt it by hand); the
      // template's first slide (its cover) stays first and its last (the
      // closing) last.
      .sort(
        (a, b) =>
          (a.index === 1 ? -1 : a.index === sections.length ? 1 : 0) -
          (b.index === 1 ? -1 : b.index === sections.length ? 1 : 0)
      )
      .slice(0, max)
      .map((slide) => fill(sections[slide.index - 1]!, slide.values))
  );
};

/**
 * Many templates write each slide's number into it as text ("03 / 18"). A
 * picked subset renumbers those by position in the printed deck, keeping the
 * template's zero padding; any other text is left alone.
 */
export const numberSlides = (
  slides: readonly string[],
  templateSlides: number
): string[] =>
  slides.map((slide, position) => {
    const edits: Array<{ start: number; end: number; text: string }> = [];
    eachTextNode(slide, (text, start, end) => {
      if (!isPageNumber(text, templateSlides)) return;
      const [, own = "", between = "", count = ""] =
        PAGE_NUMBER.exec(text.trim()) ?? [];
      // "01 / 18" pads both figures; "1 / 18" pads neither.
      const width =
        own.startsWith("0") || count.startsWith("0")
          ? Math.max(own.length, count.length)
          : 0;
      const pad = (value: number): string => String(value).padStart(width, "0");
      const leading = text.length - text.trimStart().length;
      const trailing = text.length - text.trimEnd().length;
      edits.push({
        start: start + leading,
        end: end - trailing,
        text: `${pad(position + 1)}${between}${pad(slides.length)}`,
      });
    });
    let out = slide;
    for (const edit of edits.reverse())
      out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
    return out;
  });

/** The text a template's slides contain, slot by slot. See `SlideSlot`. */
export const deckSlots = async (
  request: DeckSlotsRequest
): Promise<{
  template: string;
  available: number;
  /** How many slides to choose. */
  pick: number;
  slides: DeckSlideSlots[];
}> => {
  const { split } = await loadTemplate(request.template);
  // Indices stay the template's own, so render_deck finds the same slide.
  const offered = split.slides
    .slice(0, MAX_SLIDES)
    .map((slide, index) => ({ slide, index: index + 1 }))
    .filter(({ slide }) => isOffered(slide));
  const wanted = Math.max(
    1,
    Math.min(request.slides ?? DEFAULT_SLIDES, offered.length, MAX_SLIDES)
  );

  // Every offered slide, so the filler picks the `wanted` ones its content
  // fits rather than taking the first few.
  return {
    template: request.template,
    available: offered.length,
    pick: wanted,
    slides: offered.map(({ slide, index }) => ({
      index,
      label: slideLabel(slide, index, split.slides.length),
      slots: slotsOf(slide, split.slides.length),
    })),
  };
};

export type RenderDeckRequest = {
  template: string;
  outputPath: string;
  /** Per slide, replacement text keyed by the slot ids from `deckSlots`. */
  slides: Array<{ index: number; values: Record<string, string> }>;
  /**
   * What the numbers are checked against (the user's words, their files and
   * what the bot read) and today's date. Absent: no number check.
   */
  facts?: string;
  today?: string;
  /** The second try: a slot that still has a number not in the facts is dropped. */
  dropUnsupported?: boolean;
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
  /** Filled text drawn over other filled text. */
  overlaps?: string[];
  /** The cover's largest text as printed. */
  coverTitle?: string;
  /** Slots dropped for a number not in the facts (the second try). */
  dropped?: string[];
};

/**
 * Each slot whose printed text (the filler's, or the sample it kept) has a
 * number the facts do not give: the design system's number check, on a
 * template. With `drop`, those slots are dropped instead.
 */
const checkNumbers = (
  sections: string[],
  request: RenderDeckRequest
): {
  slides: RenderDeckRequest["slides"];
  unsupported: string[];
  dropped: string[];
} => {
  const unsupported: string[] = [];
  const dropped: string[] = [];
  if (request.facts == null)
    return { slides: request.slides, unsupported, dropped };
  const slides = request.slides.map((slide) => {
    const section = sections[slide.index];
    if (section == null) return slide;
    const values = { ...slide.values };
    for (const slot of slotsOf(section, sections.length)) {
      const sent = values[slot.id];
      const text = sent == null || sent === "" ? slot.text : sent;
      if (text === REMOVE_SLOT) continue;
      const bad = unsupportedNumbers(text, {
        brief: request.facts,
        computed: [],
        today: request.today ?? "",
      });
      if (bad.length === 0) continue;
      if (request.dropUnsupported === true) {
        values[slot.id] = REMOVE_SLOT;
        dropped.push(text.length > 60 ? `${text.slice(0, 57)}…` : text);
      } else
        unsupported.push(
          `slide ${slide.index}, slot ${slot.id}: "${text.length > 60 ? `${text.slice(0, 57)}…` : text}" has ${bad.join(", ")}`
        );
    }
    return { ...slide, values };
  });
  return { slides, unsupported, dropped };
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
  const { head, slides: sections, tail } = split;

  const numbers = checkNumbers(sections, request);
  if (numbers.unsupported.length > 0)
    return { unsupported: numbers.unsupported } as never;

  const filled = numberSlides(
    pickSlides(
      sections,
      numbers.slides,
      (slide, values) => dropRemoved(fillSlots(slide, values)),
      MAX_SLIDES
    ),
    sections.length
  );
  if (filled.length === 0)
    throw new Error("No slide of this template was chosen.");

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
  // The fonts live once, in decks/fonts, shared by every template: the deck
  // gets the ones its fonts.css names, beside it.
  const fontsDir = path.join(path.dirname(path.dirname(templateDir)), "fonts");
  const fontsCss = await fs
    .readFile(path.join(templateDir, "fonts.css"), "utf8")
    .catch(() => "");
  for (const [, name] of fontsCss.matchAll(
    /url\(["']?([^"')/]+\.woff2)["']?\)/g
  ))
    await fs.copyFile(path.join(fontsDir, name!), path.join(deckDir, name!));

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

  // The markup between slides is whitespace or comments; a newline joins them.
  const body = filled.join("\n");
  const htmlPath = path.join(deckDir, "deck.html");
  await fs.writeFile(
    htmlPath,
    retitle(withoutNotes(head + body + tail)),
    "utf8"
  );

  // The HTML is openable by now, so a failed export says where it is.
  const exported = await exportDeckPdf({
    htmlPath,
    outputPath: pdfPath,
    filled: numbers.slides.flatMap((slide) =>
      Object.values(slide.values).filter(
        (value) => value !== "" && value !== REMOVE_SLOT
      )
    ),
  }).catch((error: unknown) => {
    throw new Error(
      `the slides were written to ${modelPath(htmlPath)} but the PDF export failed: ${(error as Error)?.message ?? "unknown error"}`
    );
  });

  // A cover with no <h1> (its title in styled divs) kept the template's own
  // <title>, "Emerald Editorial Deck": the printed cover title names it.
  const printedTitle = (exported.coverTitle ?? "").replace(/\s+/g, " ").trim();
  if (printedTitle.length > 0 && !/<h1\b/i.test(filled[0] ?? "")) {
    const html = await fs.readFile(htmlPath, "utf8");
    await fs.writeFile(
      htmlPath,
      html.replace(
        /<title>[\s\S]*?<\/title>/i,
        `<title>${escapeAttr(printedTitle.slice(0, 120))}</title>`
      ),
      "utf8"
    );
  }

  return {
    pdfPath: exported.pdfPath,
    htmlPath,
    pptxPath: exported.pptxPath,
    pptxError: exported.pptxError ?? null,
    template: request.template,
    slides: exported.slides,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
    ...(exported.overlaps != null ? { overlaps: exported.overlaps } : {}),
    ...(exported.coverTitle != null ? { coverTitle: exported.coverTitle } : {}),
    ...(numbers.dropped.length > 0 ? { dropped: numbers.dropped } : {}),
  };
};
