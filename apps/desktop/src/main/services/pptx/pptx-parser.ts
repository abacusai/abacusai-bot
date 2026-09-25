/**
 * Turns a .pptx package into the flat slide model the preview panel renders.
 * Slides resolve against layout, master and theme the way PowerPoint does, so
 * a deck looks like its template. Charts, SmartArt and embedded media become
 * labelled frames rather than pretend renders.
 */
import path from "path";

import type {
  PptxDeck,
  PptxFill,
  PptxLine,
  PptxParagraph,
  PptxShape,
  PptxSlide,
  PptxTableCell,
  PptxTextBody,
  PptxTextRun,
} from "#shared/pptx";

import {
  attr,
  attrBool,
  attrInt,
  child,
  children,
  find,
  findAll,
  parseXml,
  type XmlNode,
} from "./xml";
import { ZipArchive } from "./zip";

/** Slide size PowerPoint falls back to (10in × 7.5in, 4:3) when unstated. */
const DEFAULT_WIDTH_EMU = 9144000;
const DEFAULT_HEIGHT_EMU = 6858000;

/** Default text insets for a shape (0.1in left/right, 0.05in top/bottom). */
const DEFAULT_INSETS = { left: 91440, top: 45720, right: 91440, bottom: 45720 };

/** Per-image and whole-deck ceilings on inlined media, in bytes of source. */
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_TOTAL_IMAGE_BYTES = 64 * 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".bmp": "image/bmp",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".tif": "image/tiff",
  ".tiff": "image/tiff",
};

/** Frame labels for the graphic types that render as a placeholder. */
const GRAPHIC_LABELS: Array<{ marker: string; label: string }> = [
  { marker: "chart", label: "Chart" },
  { marker: "diagram", label: "Diagram" },
  { marker: "ole", label: "Embedded object" },
  { marker: "table", label: "Table" },
];

type ColorContext = {
  /** Theme colour scheme: `accent1` → `4472C4`. */
  scheme: Record<string, string>;
  /** Master colour map: `bg1` → `lt1`. */
  map: Record<string, string>;
  majorFont: string | null;
  minorFont: string | null;
};

type Placeholder = {
  type: string;
  idx: string;
  shape: XmlNode;
};

type SlideContext = {
  colors: ColorContext;
  /** Rel id → archive path, for the slide part being read. */
  rels: Map<string, string>;
  layoutRels: Map<string, string>;
  masterRels: Map<string, string>;
  layoutPlaceholders: Map<string, Placeholder>;
  masterPlaceholders: Map<string, Placeholder>;
  /** `p:txStyles` from the master, the last stop in the text cascade. */
  masterTextStyles: XmlNode | null;
};

export type ParseOptions = {
  /** Cap on slides read; the rest are reported as a warning. */
  maxSlides?: number;
};

export function parsePptx(
  buffer: Buffer,
  options: ParseOptions = {}
): PptxDeck {
  const zip = ZipArchive.open(buffer);
  const warnings: string[] = [];
  const state = { imageBytes: 0, warnings };
  zCounter = 0;

  const presentationXml = zip.readText("ppt/presentation.xml");
  if (presentationXml == null) throw new Error("not-a-presentation");
  const presentation = parseXml(presentationXml);
  const presentationRoot = child(presentation, "p:presentation");

  const sldSz = child(presentationRoot, "p:sldSz");
  const widthEmu = attrInt(sldSz, "cx") ?? DEFAULT_WIDTH_EMU;
  const heightEmu = attrInt(sldSz, "cy") ?? DEFAULT_HEIGHT_EMU;

  const presentationRels = readRels(zip, "ppt/presentation.xml");
  const slideIds = children(child(presentationRoot, "p:sldIdLst"), "p:sldId");

  const slidePaths: string[] = [];
  for (const sldId of slideIds) {
    const rid = attr(sldId, "r:id");
    const target = rid != null ? presentationRels.get(rid) : null;
    if (target != null) slidePaths.push(target);
  }
  // Some generators omit sldIdLst; fall back to the parts themselves.
  if (slidePaths.length === 0) {
    slidePaths.push(
      ...zip
        .list()
        .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
        .sort(bySlideNumber)
    );
  }

  const maxSlides = options.maxSlides ?? 300;
  const limited = slidePaths.slice(0, maxSlides);
  if (slidePaths.length > limited.length) {
    warnings.push(
      `Showing the first ${limited.length} of ${slidePaths.length} slides.`
    );
  }

  const slides: PptxSlide[] = [];
  let themeName: string | null = null;

  limited.forEach((slidePath, index) => {
    try {
      const parsed = parseSlide(zip, slidePath, index + 1, warnings, state);
      if (parsed != null) {
        slides.push(parsed.slide);
        themeName ??= parsed.themeName;
      }
    } catch (err) {
      warnings.push(
        `Slide ${index + 1} could not be read (${(err as Error)?.message ?? "unknown error"}).`
      );
      slides.push(emptySlide(index + 1));
    }
  });

  return {
    widthEmu,
    heightEmu,
    slides,
    title: readCoreTitle(zip),
    themeName,
    warnings,
  };
}

// Package plumbing

function bySlideNumber(a: string, b: string): number {
  const na = Number.parseInt(a.replace(/\D+/g, ""), 10);
  const nb = Number.parseInt(b.replace(/\D+/g, ""), 10);
  return na - nb;
}

/** Rel id → archive-absolute target for one part. */
function readRels(zip: ZipArchive, partPath: string): Map<string, string> {
  const dir = path.posix.dirname(partPath);
  const relsPath = path.posix.join(
    dir,
    "_rels",
    `${path.posix.basename(partPath)}.rels`
  );
  const map = new Map<string, string>();
  const xml = zip.readText(relsPath);
  if (xml == null) return map;

  for (const rel of findAll(parseXml(xml), "Relationship")) {
    const id = attr(rel, "Id");
    const target = attr(rel, "Target");
    if (id == null || target == null) continue;
    // External targets (hyperlinks, linked media) have no part to read.
    if (
      attr(rel, "TargetMode") === "External" ||
      /^[a-z]+:\/\//i.test(target)
    ) {
      map.set(id, target);
      continue;
    }
    // A target starting with "/" is package-absolute, not part-relative.
    const resolved = target.startsWith("/")
      ? path.posix.normalize(target.replace(/^\/+/, ""))
      : path.posix.normalize(path.posix.join(dir, target)).replace(/^\/+/, "");
    map.set(id, resolved);
  }
  return map;
}

function readPart(
  zip: ZipArchive,
  partPath: string | null | undefined
): XmlNode | null {
  if (partPath == null) return null;
  const xml = zip.readText(partPath);
  return xml == null ? null : parseXml(xml);
}

function readCoreTitle(zip: ZipArchive): string | null {
  const core = readPart(zip, "docProps/core.xml");
  const title = find(core, "dc:title")?.text?.trim();
  return title != null && title.length > 0 ? title : null;
}

/** First target whose part path matches a predicate: layouts, masters, themes. */
function relTarget(rels: Map<string, string>, test: RegExp): string | null {
  for (const target of rels.values()) {
    if (test.test(target)) return target;
  }
  return null;
}

// Theme

function readColorContext(
  zip: ZipArchive,
  themePath: string | null,
  master: XmlNode | null
): ColorContext {
  const scheme: Record<string, string> = {
    dk1: "000000",
    lt1: "FFFFFF",
    dk2: "44546A",
    lt2: "E7E6E6",
    accent1: "4472C4",
    accent2: "ED7D31",
    accent3: "A5A5A5",
    accent4: "FFC000",
    accent5: "5B9BD5",
    accent6: "70AD47",
    hlink: "0563C1",
    folHlink: "954F72",
  };

  const theme = readPart(zip, themePath);
  const clrScheme = find(theme, "a:clrScheme");
  for (const entry of clrScheme?.children ?? []) {
    const key = entry.name.replace(/^a:/, "");
    const srgb = child(entry, "a:srgbClr");
    const sys = child(entry, "a:sysClr");
    const value = attr(srgb, "val") ?? attr(sys, "lastClr");
    if (value != null) scheme[key] = value.replace("#", "").toUpperCase();
  }

  const fontScheme = find(theme, "a:fontScheme");
  const majorFont = attr(
    find(child(fontScheme, "a:majorFont"), "a:latin"),
    "typeface"
  );
  const minorFont = attr(
    find(child(fontScheme, "a:minorFont"), "a:latin"),
    "typeface"
  );

  // The master's colour map decides which scheme slot `bg1`/`tx1` point at.
  const map: Record<string, string> = {
    bg1: "lt1",
    tx1: "dk1",
    bg2: "lt2",
    tx2: "dk2",
  };
  const clrMap = child(master, "p:clrMap");
  for (const [key, fallback] of Object.entries(map)) {
    map[key] = attr(clrMap, key) ?? fallback;
  }

  return { scheme, map, majorFont, minorFont };
}

// Colour and fill

/** Resolves any of the `a:*Clr` color choices under a parent node. */
function resolveColorChild(
  parent: XmlNode | null,
  ctx: ColorContext
): string | null {
  if (parent == null) return null;
  for (const node of parent.children) {
    const resolved = resolveColorNode(node, ctx);
    if (resolved != null) return resolved;
  }
  return null;
}

function resolveColorNode(node: XmlNode, ctx: ColorContext): string | null {
  let base: string | null = null;

  switch (node.name) {
    case "a:srgbClr":
      base = attr(node, "val")?.replace("#", "") ?? null;
      break;
    case "a:schemeClr": {
      const raw = attr(node, "val");
      if (raw == null) break;
      // `phClr` has no slide-level meaning here; treat it as the first accent.
      const mapped = raw === "phClr" ? "accent1" : (ctx.map[raw] ?? raw);
      base = ctx.scheme[mapped] ?? ctx.scheme[raw] ?? null;
      break;
    }
    case "a:sysClr":
      base = attr(node, "lastClr") ?? null;
      break;
    case "a:prstClr":
      base = PRESET_COLORS[attr(node, "val") ?? ""] ?? null;
      break;
    case "a:scrgbClr": {
      const toByte = (v: string | null): number =>
        Math.round(((Number.parseInt(v ?? "0", 10) || 0) / 100000) * 255);
      base = [attr(node, "r"), attr(node, "g"), attr(node, "b")]
        .map((c) => toByte(c).toString(16).padStart(2, "0"))
        .join("");
      break;
    }
    default:
      return null;
  }

  if (base == null) return null;
  return applyColorTransforms(base.toUpperCase(), node);
}

/** Applies the luminance/tint/shade/alpha modifiers a colour node may carry. */
function applyColorTransforms(hex: string, node: XmlNode): string {
  let { r, g, b } = hexToRgb(hex);
  let alpha = 1;

  for (const mod of node.children) {
    const value = attrInt(mod, "val");
    if (value == null) continue;
    const pct = value / 100000;
    switch (mod.name) {
      case "a:lumMod": {
        const hsl = rgbToHsl(r, g, b);
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, clamp01(hsl.l * pct)));
        break;
      }
      case "a:lumOff": {
        const hsl = rgbToHsl(r, g, b);
        ({ r, g, b } = hslToRgb(hsl.h, hsl.s, clamp01(hsl.l + pct)));
        break;
      }
      case "a:shade":
        r = Math.round(r * pct);
        g = Math.round(g * pct);
        b = Math.round(b * pct);
        break;
      case "a:tint":
        r = Math.round(r * pct + 255 * (1 - pct));
        g = Math.round(g * pct + 255 * (1 - pct));
        b = Math.round(b * pct + 255 * (1 - pct));
        break;
      case "a:satMod": {
        const hsl = rgbToHsl(r, g, b);
        ({ r, g, b } = hslToRgb(hsl.h, clamp01(hsl.s * pct), hsl.l));
        break;
      }
      case "a:alpha":
        alpha = clamp01(pct);
        break;
      default:
        break;
    }
  }

  const clampByte = (v: number): number =>
    Math.max(0, Math.min(255, Math.round(v)));
  if (alpha < 1)
    return `rgba(${clampByte(r)}, ${clampByte(g)}, ${clampByte(b)}, ${alpha.toFixed(3)})`;
  return `#${[r, g, b].map((v) => clampByte(v).toString(16).padStart(2, "0")).join("")}`;
}

function readFill(
  container: XmlNode | null,
  ctx: ColorContext,
  zip: ZipArchive,
  rels: Map<string, string>,
  state: { imageBytes: number }
): PptxFill | null {
  if (container == null) return null;

  if (child(container, "a:noFill") != null) return { type: "none" };

  const solid = child(container, "a:solidFill");
  if (solid != null) {
    const color = resolveColorChild(solid, ctx);
    return color != null ? { type: "solid", color } : null;
  }

  const grad = child(container, "a:gradFill");
  if (grad != null) {
    const stops = children(child(grad, "a:gsLst"), "a:gs")
      .map((gs) => ({
        color: resolveColorChild(gs, ctx) ?? "#FFFFFF",
        positionPct: (attrInt(gs, "pos") ?? 0) / 1000,
      }))
      .sort((a, b) => a.positionPct - b.positionPct);
    if (stops.length > 0) {
      // OOXML measures the angle from "to the right", CSS from "to the top".
      const angle = (attrInt(child(grad, "a:lin"), "ang") ?? 0) / 60000;
      return { type: "gradient", angleDeg: angle + 90, stops };
    }
  }

  const blip = child(container, "a:blipFill");
  if (blip != null) {
    const dataUrl = readBlipImage(blip, zip, rels, state);
    if (dataUrl != null) return { type: "image", dataUrl };
  }

  // A pattern fill is approximated by its foreground colour.
  const pattern = child(container, "a:pattFill");
  if (pattern != null) {
    const color = resolveColorChild(child(pattern, "a:fgClr"), ctx);
    return color != null ? { type: "solid", color } : null;
  }

  return null;
}

function readBlipImage(
  blipFill: XmlNode,
  zip: ZipArchive,
  rels: Map<string, string>,
  state: { imageBytes: number; warnings?: string[] }
): string | null {
  const blip = find(blipFill, "a:blip");
  const rid = attr(blip, "r:embed");
  if (rid == null) return null;
  const target = rels.get(rid);
  if (target == null || /^[a-z]+:\/\//i.test(target)) return null;

  const ext = path.posix.extname(target).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime == null) return null;

  const bytes = zip.read(target);
  if (bytes == null) return null;
  // An image dropped for size should say so, or it reads as a parser bug.
  const mb = (n: number): string => `${Math.round(n / (1024 * 1024))} MB`;
  if (bytes.length > MAX_IMAGE_BYTES) {
    state.warnings?.push(
      `Image ${path.posix.basename(target)} (${mb(bytes.length)}) was left out: over the ${mb(MAX_IMAGE_BYTES)} per-image limit.`
    );
    return null;
  }
  if (state.imageBytes + bytes.length > MAX_TOTAL_IMAGE_BYTES) {
    state.warnings?.push(
      `Image ${path.posix.basename(target)} was left out: the deck's images passed the ${mb(MAX_TOTAL_IMAGE_BYTES)} total limit.`
    );
    return null;
  }
  state.imageBytes += bytes.length;

  return `data:${mime};base64,${bytes.toString("base64")}`;
}

function readLine(spPr: XmlNode | null, ctx: ColorContext): PptxLine | null {
  const ln = child(spPr, "a:ln");
  if (ln == null) return null;
  if (child(ln, "a:noFill") != null) return null;
  const color = resolveColorChild(child(ln, "a:solidFill"), ctx);
  if (color == null) return null;
  return {
    color,
    widthEmu: attrInt(ln, "w") ?? 9525,
    dashed: (attr(child(ln, "a:prstDash"), "val") ?? "solid") !== "solid",
  };
}

// Slides

function emptySlide(number: number): PptxSlide {
  return {
    number,
    background: { type: "solid", color: "#FFFFFF" },
    templateShapes: [],
    shapes: [],
    notes: null,
    layoutName: null,
    title: null,
    hidden: false,
  };
}

function parseSlide(
  zip: ZipArchive,
  slidePath: string,
  number: number,
  warnings: string[],
  state: { imageBytes: number }
): { slide: PptxSlide; themeName: string | null } | null {
  const slideDoc = readPart(zip, slidePath);
  if (slideDoc == null) {
    warnings.push(`Slide ${number} is missing from the package.`);
    return { slide: emptySlide(number), themeName: null };
  }
  const slideRoot = child(slideDoc, "p:sld");
  const rels = readRels(zip, slidePath);

  const layoutPath = relTarget(rels, /slideLayouts\/[^/]+\.xml$/);
  const layoutDoc = readPart(zip, layoutPath);
  const layoutRoot = child(layoutDoc, "p:sldLayout");
  const layoutRels =
    layoutPath != null ? readRels(zip, layoutPath) : new Map<string, string>();

  const masterPath = relTarget(layoutRels, /slideMasters\/[^/]+\.xml$/);
  const masterDoc = readPart(zip, masterPath);
  const masterRoot = child(masterDoc, "p:sldMaster");
  const masterRels =
    masterPath != null ? readRels(zip, masterPath) : new Map<string, string>();

  const themePath = relTarget(masterRels, /theme\/[^/]+\.xml$/);
  const colors = readColorContext(zip, themePath, masterRoot);
  const themeName = attr(child(readPart(zip, themePath), "a:theme"), "name");

  const ctx: SlideContext = {
    colors,
    rels,
    layoutRels,
    masterRels,
    layoutPlaceholders: collectPlaceholders(layoutRoot),
    masterPlaceholders: collectPlaceholders(masterRoot),
    masterTextStyles: find(masterRoot, "p:txStyles"),
  };

  const background = readBackground(
    child(slideRoot, "p:cSld"),
    colors,
    zip,
    rels,
    state
  ) ??
    readBackground(
      child(layoutRoot, "p:cSld"),
      colors,
      zip,
      layoutRels,
      state
    ) ??
    readBackground(
      child(masterRoot, "p:cSld"),
      colors,
      zip,
      masterRels,
      state
    ) ?? {
      type: "solid",
      color: "#FFFFFF",
    };

  // The template's furniture. Unfilled placeholders are prompts, not content;
  // `showMasterSp` hides master shapes only, the layout's own always show.
  const templateShapes: PptxShape[] = [];
  const showMasterShapes = attrBool(layoutRoot, "showMasterSp") ?? true;
  if (showMasterShapes && (attrBool(slideRoot, "showMasterSp") ?? true)) {
    templateShapes.push(
      ...readShapeTree(
        find(masterRoot, "p:spTree"),
        { ...ctx, rels: masterRels },
        zip,
        state,
        {
          skipPlaceholders: true,
        }
      )
    );
  }
  templateShapes.push(
    ...readShapeTree(
      find(layoutRoot, "p:spTree"),
      { ...ctx, rels: layoutRels },
      zip,
      state,
      {
        skipPlaceholders: true,
      }
    )
  );

  const shapes = readShapeTree(find(slideRoot, "p:spTree"), ctx, zip, state, {
    skipPlaceholders: false,
  });

  const notesPath = relTarget(rels, /notesSlides\/[^/]+\.xml$/);
  const notes = readNotes(readPart(zip, notesPath));

  return {
    slide: {
      number,
      background,
      templateShapes,
      shapes,
      notes,
      layoutName: attr(child(layoutRoot, "p:cSld"), "name"),
      title: findSlideTitle(slideRoot, shapes),
      hidden: attr(slideRoot, "show") === "0",
    },
    themeName,
  };
}

function readBackground(
  cSld: XmlNode | null,
  ctx: ColorContext,
  zip: ZipArchive,
  rels: Map<string, string>,
  state: { imageBytes: number }
): PptxFill | null {
  const bg = child(cSld, "p:bg");
  if (bg == null) return null;

  const bgPr = child(bg, "p:bgPr");
  if (bgPr != null) return readFill(bgPr, ctx, zip, rels, state);

  // `p:bgRef` names a theme background style plus a colour; use the colour.
  const bgRef = child(bg, "p:bgRef");
  if (bgRef != null) {
    const color = resolveColorChild(bgRef, ctx);
    if (color != null) return { type: "solid", color };
  }
  return null;
}

function readNotes(notesDoc: XmlNode | null): string | null {
  if (notesDoc == null) return null;
  // Only the body placeholder carries what the presenter wrote.
  const bodies = findAll(notesDoc, "p:sp").filter((sp) => {
    const ph = find(sp, "p:ph");
    return attr(ph, "type") === "body";
  });
  const text = bodies
    .map((sp) =>
      children(find(sp, "p:txBody"), "a:p")
        .map((p) =>
          findAll(p, "a:t")
            .map((t) => t.text)
            .join("")
        )
        .join("\n")
    )
    .join("\n")
    .trim();
  return text.length > 0 ? text : null;
}

/** The title placeholder, else the first line of text; labels the thumbnail. */
function findSlideTitle(
  slideRoot: XmlNode | null,
  shapes: PptxShape[]
): string | null {
  for (const sp of findAll(find(slideRoot, "p:spTree"), "p:sp")) {
    const type = attr(placeholderOf(sp), "type");
    if (type !== "title" && type !== "ctrTitle") continue;
    const text = findAll(child(sp, "p:txBody"), "a:t")
      .map((t) => t.text)
      .join(" ")
      .trim();
    if (text.length > 0) return text.slice(0, 120);
  }

  // No title placeholder: the largest type is the closest thing to a heading.
  let best: { text: string; sizePt: number } | null = null;
  for (const shape of shapes) {
    if (shape.kind !== "shape" || shape.body == null) continue;
    const text = shape.body.paragraphs
      .map((p) => p.runs.map((r) => r.text).join(""))
      .join(" ")
      .trim();
    if (text.length === 0) continue;
    const sizePt = Math.max(
      ...shape.body.paragraphs.flatMap((p) =>
        p.runs.map((r) => r.sizePt ?? 18)
      ),
      0
    );
    if (best == null || sizePt > best.sizePt) best = { text, sizePt };
  }
  return best?.text.slice(0, 120) ?? null;
}

// Shape tree

function collectPlaceholders(root: XmlNode | null): Map<string, Placeholder> {
  const map = new Map<string, Placeholder>();
  for (const sp of findAll(find(root, "p:spTree"), "p:sp")) {
    const ph = placeholderOf(sp);
    if (ph == null) continue;
    const type = attr(ph, "type") ?? "body";
    const idx = attr(ph, "idx") ?? "";
    const entry: Placeholder = { type, idx, shape: sp };
    if (idx !== "") map.set(`idx:${idx}`, entry);
    if (!map.has(`type:${type}`)) map.set(`type:${type}`, entry);
  }
  return map;
}

type ShapeTreeOptions = {
  skipPlaceholders: boolean;
  /** Group transform applied to child offsets. */
  transform?: GroupTransform;
};

type GroupTransform = {
  offsetX: number;
  offsetY: number;
  scaleX: number;
  scaleY: number;
  childOffsetX: number;
  childOffsetY: number;
};

function readShapeTree(
  spTree: XmlNode | null,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number },
  options: ShapeTreeOptions,
  out: PptxShape[] = []
): PptxShape[] {
  if (spTree == null) return out;

  for (const node of spTree.children) {
    switch (node.name) {
      case "p:sp": {
        const shape = readShape(node, ctx, zip, state, options);
        if (shape != null) out.push(shape);
        break;
      }
      case "p:pic": {
        const shape = readPicture(node, ctx, zip, state, options);
        if (shape != null) out.push(shape);
        break;
      }
      case "p:graphicFrame": {
        const shape = readGraphicFrame(node, ctx, zip, state, options);
        if (shape != null) out.push(shape);
        break;
      }
      case "p:grpSp": {
        readGroup(node, ctx, zip, state, options, out);
        break;
      }
      case "p:cxnSp": {
        // Connectors are line-only shapes; the generic reader draws them.
        const shape = readShape(node, ctx, zip, state, options);
        if (shape != null) out.push(shape);
        break;
      }
      default:
        break;
    }
  }
  return out;
}

function readGroup(
  grp: XmlNode,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number },
  options: ShapeTreeOptions,
  out: PptxShape[]
): void {
  const xfrm = find(child(grp, "p:grpSpPr"), "a:xfrm");
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  const chOff = child(xfrm, "a:chOff");
  const chExt = child(xfrm, "a:chExt");

  const childWidth = attrInt(chExt, "cx") ?? 0;
  const childHeight = attrInt(chExt, "cy") ?? 0;
  const groupWidth = attrInt(ext, "cx") ?? childWidth;
  const groupHeight = attrInt(ext, "cy") ?? childHeight;

  // A group re-maps its children's space; compose with the enclosing group.
  const local: GroupTransform = {
    offsetX: attrInt(off, "x") ?? 0,
    offsetY: attrInt(off, "y") ?? 0,
    scaleX: childWidth > 0 ? groupWidth / childWidth : 1,
    scaleY: childHeight > 0 ? groupHeight / childHeight : 1,
    childOffsetX: attrInt(chOff, "x") ?? 0,
    childOffsetY: attrInt(chOff, "y") ?? 0,
  };

  // Non-shape children (`p:nvGrpSpPr`, `p:grpSpPr`) fall through the switch.
  readShapeTree(
    grp,
    ctx,
    zip,
    state,
    {
      ...options,
      transform: composeTransforms(options.transform, local),
    },
    out
  );
}

function composeTransforms(
  outer: GroupTransform | undefined,
  inner: GroupTransform
): GroupTransform {
  if (outer == null) return inner;
  // Map the inner frame through the outer transform; scales multiply.
  return {
    offsetX:
      outer.offsetX + (inner.offsetX - outer.childOffsetX) * outer.scaleX,
    offsetY:
      outer.offsetY + (inner.offsetY - outer.childOffsetY) * outer.scaleY,
    scaleX: inner.scaleX * outer.scaleX,
    scaleY: inner.scaleY * outer.scaleY,
    childOffsetX: inner.childOffsetX,
    childOffsetY: inner.childOffsetY,
  };
}

let zCounter = 0;

type Frame = {
  xEmu: number;
  yEmu: number;
  widthEmu: number;
  heightEmu: number;
  rotationDeg?: number;
  flipH?: boolean;
  flipV?: boolean;
};

function readFrame(
  xfrm: XmlNode | null,
  transform?: GroupTransform
): Frame | null {
  const off = child(xfrm, "a:off");
  const ext = child(xfrm, "a:ext");
  const x = attrInt(off, "x");
  const y = attrInt(off, "y");
  const cx = attrInt(ext, "cx");
  const cy = attrInt(ext, "cy");
  if (x == null || y == null || cx == null || cy == null) return null;

  const frame: Frame = {
    xEmu: x,
    yEmu: y,
    widthEmu: cx,
    heightEmu: cy,
    rotationDeg: (attrInt(xfrm, "rot") ?? 0) / 60000,
    flipH: attrBool(xfrm, "flipH") ?? false,
    flipV: attrBool(xfrm, "flipV") ?? false,
  };

  if (transform != null) {
    frame.xEmu =
      transform.offsetX + (x - transform.childOffsetX) * transform.scaleX;
    frame.yEmu =
      transform.offsetY + (y - transform.childOffsetY) * transform.scaleY;
    frame.widthEmu = cx * transform.scaleX;
    frame.heightEmu = cy * transform.scaleY;
  }
  return frame;
}

/**
 * The layout and master placeholders this shape inherits from, nearest first,
 * each with its own part's rels: an inherited picture fill uses those.
 */
type InheritedSource = { shape: XmlNode; rels: Map<string, string> };

/** `p:ph` lives only under the per-kind `p:nv*Pr`, so one search covers all. */
function placeholderOf(node: XmlNode): XmlNode | null {
  return find(node, "p:ph");
}

function inheritedPlaceholders(
  sp: XmlNode,
  ctx: SlideContext
): InheritedSource[] {
  const ph = placeholderOf(sp);
  if (ph == null) return [];
  const idx = attr(ph, "idx");
  const type = attr(ph, "type") ?? "body";

  const chain: InheritedSource[] = [];
  const layout =
    (idx != null ? ctx.layoutPlaceholders.get(`idx:${idx}`) : null) ??
    ctx.layoutPlaceholders.get(`type:${type}`);
  if (layout != null) chain.push({ shape: layout.shape, rels: ctx.layoutRels });

  // Masters only carry canonical placeholder types; type is the key there.
  const masterType =
    type === "ctrTitle" ? "title" : type === "subTitle" ? "body" : type;
  const master = ctx.masterPlaceholders.get(`type:${masterType}`);
  if (master != null) chain.push({ shape: master.shape, rels: ctx.masterRels });

  return chain;
}

function readShape(
  sp: XmlNode,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number },
  options: ShapeTreeOptions
): PptxShape | null {
  const ph = placeholderOf(sp);
  if (options.skipPlaceholders && ph != null) return null;

  const spPr = child(sp, "p:spPr");
  const inherited = inheritedPlaceholders(sp, ctx);

  // Geometry may live on the slide shape or be inherited from the placeholder.
  let frame = readFrame(child(spPr, "a:xfrm"), options.transform);
  for (const source of inherited) {
    if (frame != null) break;
    frame = readFrame(
      find(child(source.shape, "p:spPr"), "a:xfrm"),
      options.transform
    );
  }
  if (frame == null) return null;

  const txBody = child(sp, "p:txBody");
  const geometry = attr(child(spPr, "a:prstGeom"), "val") ?? "rect";

  let fill = readFill(spPr, ctx.colors, zip, ctx.rels, state);
  // A placeholder with no fill inherits the layout's (template title bars).
  if (fill == null && ph != null) {
    for (const source of inherited) {
      fill = readFill(
        child(source.shape, "p:spPr"),
        ctx.colors,
        zip,
        source.rels,
        state
      );
      if (fill != null) break;
    }
  }

  const body = txBody != null ? readTextBody(txBody, sp, inherited, ctx) : null;
  const hasText =
    body != null &&
    body.paragraphs.some((p) => p.runs.some((r) => r.text.trim().length > 0));

  // An empty, fill-less, line-less shape contributes nothing to the render.
  const line = readLine(spPr, ctx.colors);
  if (!hasText && (fill == null || fill.type === "none") && line == null)
    return null;

  return {
    kind: "shape",
    id: attr(find(sp, "p:cNvPr"), "id") ?? `sp-${zCounter}`,
    ...frame,
    z: zCounter++,
    fill: fill ?? { type: "none" },
    line,
    geometry,
    body: hasText ? body : null,
  };
}

function readPicture(
  pic: XmlNode,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number },
  options: ShapeTreeOptions
): PptxShape | null {
  const spPr = child(pic, "p:spPr");
  // A picture in a picture placeholder takes the frame the layout reserved.
  let frame = readFrame(child(spPr, "a:xfrm"), options.transform);
  for (const source of inheritedPlaceholders(pic, ctx)) {
    if (frame != null) break;
    frame = readFrame(
      find(child(source.shape, "p:spPr"), "a:xfrm"),
      options.transform
    );
  }
  if (frame == null) return null;

  const blipFill = child(pic, "p:blipFill");
  const dataUrl =
    blipFill != null ? readBlipImage(blipFill, zip, ctx.rels, state) : null;
  if (dataUrl == null) return null;

  return {
    kind: "image",
    id: attr(find(pic, "p:cNvPr"), "id") ?? `pic-${zCounter}`,
    ...frame,
    z: zCounter++,
    dataUrl,
    line: readLine(spPr, ctx.colors),
    geometry: attr(child(spPr, "a:prstGeom"), "val") ?? "rect",
  };
}

function readGraphicFrame(
  frameNode: XmlNode,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number },
  options: ShapeTreeOptions
): PptxShape | null {
  const frame = readFrame(child(frameNode, "p:xfrm"), options.transform);
  if (frame == null) return null;

  const table = find(frameNode, "a:tbl");
  if (table != null) {
    return readTable(table, frameNode, frame, ctx, zip, state);
  }

  const uri = attr(find(frameNode, "a:graphicData"), "uri") ?? "";
  const label =
    GRAPHIC_LABELS.find((entry) => uri.toLowerCase().includes(entry.marker))
      ?.label ?? "Embedded content";

  return {
    kind: "placeholder-frame",
    id: attr(find(frameNode, "p:cNvPr"), "id") ?? `gf-${zCounter}`,
    ...frame,
    z: zCounter++,
    label,
    fill: { type: "none" },
  };
}

function readTable(
  tbl: XmlNode,
  frameNode: XmlNode,
  frame: Frame,
  ctx: SlideContext,
  zip: ZipArchive,
  state: { imageBytes: number }
): PptxShape {
  const columnWidthsEmu = children(find(tbl, "a:tblGrid"), "a:gridCol").map(
    (col) => attrInt(col, "w") ?? 0
  );

  const rows = children(tbl, "a:tr").map((tr) => {
    const cells: PptxTableCell[] = children(tr, "a:tc").map((tc) => {
      const tcPr = child(tc, "a:tcPr");
      const body = readTextBody(child(tc, "a:txBody"), tc, [], ctx, {
        left: attrInt(tcPr, "marL") ?? 91440,
        top: attrInt(tcPr, "marT") ?? 45720,
        right: attrInt(tcPr, "marR") ?? 91440,
        bottom: attrInt(tcPr, "marB") ?? 45720,
      });
      return {
        body,
        fill: readFill(tcPr, ctx.colors, zip, ctx.rels, state) ?? {
          type: "none",
        },
        colSpan: attrInt(tc, "gridSpan") ?? 1,
        rowSpan: attrInt(tc, "rowSpan") ?? 1,
        merged:
          attrBool(tc, "hMerge") === true || attrBool(tc, "vMerge") === true,
      };
    });
    return { heightEmu: attrInt(tr, "h") ?? 0, cells };
  });

  return {
    kind: "table",
    id: attr(find(frameNode, "p:cNvPr"), "id") ?? `tbl-${zCounter}`,
    ...frame,
    z: zCounter++,
    columnWidthsEmu,
    rows,
  };
}

// Text

const ALIGN_MAP: Record<string, PptxParagraph["align"]> = {
  l: "left",
  ctr: "center",
  r: "right",
  just: "justify",
  dist: "justify",
};

const ANCHOR_MAP: Record<string, PptxTextBody["anchor"]> = {
  t: "top",
  ctr: "center",
  b: "bottom",
};

/**
 * Reads a text body through PowerPoint's cascade: run, paragraph default,
 * shape list style, layout placeholder, master placeholder, master text styles.
 */
function readTextBody(
  txBody: XmlNode | null,
  owner: XmlNode,
  inherited: InheritedSource[],
  ctx: SlideContext,
  insetOverride?: PptxTextBody["insets"]
): PptxTextBody {
  const bodyPr = child(txBody, "a:bodyPr");
  const phType = attr(placeholderOf(owner), "type") ?? null;

  const listStyles: XmlNode[] = [];
  const own = child(txBody, "a:lstStyle");
  if (own != null) listStyles.push(own);
  for (const source of inherited) {
    const style = find(child(source.shape, "p:txBody"), "a:lstStyle");
    if (style != null) listStyles.push(style);
  }
  const masterStyle = masterTextStyleFor(phType, ctx);
  if (masterStyle != null) listStyles.push(masterStyle);

  const paragraphs: PptxParagraph[] = [];
  // Auto-numbered lists count per level, restarting when the level changes.
  const numbering = new Map<number, number>();

  for (const p of children(txBody, "a:p")) {
    const pPr = child(p, "a:pPr");
    const level = attrInt(pPr, "lvl") ?? 0;
    const levelDefaults = listStyles
      .map((style) => child(style, `a:lvl${level + 1}pPr`))
      .filter((n): n is XmlNode => n != null);
    const propChain = [pPr, ...levelDefaults].filter(
      (n): n is XmlNode => n != null
    );

    const runs: PptxTextRun[] = [];
    for (const node of p.children) {
      if (node.name === "a:r") {
        const text = children(node, "a:t")
          .map((t) => t.text)
          .join("");
        if (text.length === 0) continue;
        runs.push(readRun(child(node, "a:rPr"), propChain, ctx, phType, node));
      } else if (node.name === "a:br") {
        runs.push({ text: "\n" });
      } else if (node.name === "a:fld") {
        // Slide numbers and dates are stored with their last-rendered text.
        const text = children(node, "a:t")
          .map((t) => t.text)
          .join("");
        if (text.length > 0)
          runs.push(
            readRun(child(node, "a:rPr"), propChain, ctx, phType, node)
          );
      }
    }

    const bullet = readBullet(propChain, level, numbering, runs.length > 0);
    const align = firstAttr(propChain, "algn");

    paragraphs.push({
      runs,
      level,
      align: align != null ? ALIGN_MAP[align] : undefined,
      bullet: bullet.glyph,
      bulletColor: bullet.color != null ? bullet.color : undefined,
      lineSpacing: firstSpacing(propChain, "a:lnSpc"),
      spaceBeforePt: firstSpacingPoints(propChain, "a:spcBef"),
      spaceAfterPt: firstSpacingPoints(propChain, "a:spcAft"),
    });
  }

  const fontScalePct = attrInt(find(bodyPr, "a:normAutofit"), "fontScale");

  return {
    paragraphs,
    anchor: ANCHOR_MAP[attr(bodyPr, "anchor") ?? "t"] ?? "top",
    insets: insetOverride ?? {
      left: attrInt(bodyPr, "lIns") ?? DEFAULT_INSETS.left,
      top: attrInt(bodyPr, "tIns") ?? DEFAULT_INSETS.top,
      right: attrInt(bodyPr, "rIns") ?? DEFAULT_INSETS.right,
      bottom: attrInt(bodyPr, "bIns") ?? DEFAULT_INSETS.bottom,
    },
    fontScale: fontScalePct != null ? fontScalePct / 100000 : undefined,
    wrap: (attr(bodyPr, "wrap") ?? "square") !== "none",
  };
}

/**
 * The master text style a shape inherits from. A plain text box takes
 * `otherStyle`, not `bodyStyle`, which carries the master's bullets.
 */
function masterTextStyleFor(
  phType: string | null,
  ctx: SlideContext
): XmlNode | null {
  const styles = ctx.masterTextStyles;
  if (styles == null) return null;
  if (phType === "title" || phType === "ctrTitle")
    return child(styles, "p:titleStyle");
  if (phType === "body" || phType === "subTitle" || phType === "obj") {
    return child(styles, "p:bodyStyle");
  }
  return child(styles, "p:otherStyle");
}

function readRun(
  rPr: XmlNode | null,
  propChain: XmlNode[],
  ctx: SlideContext,
  phType: string | null,
  runNode: XmlNode
): PptxTextRun {
  // Run properties win; each level of the chain contributes its `a:defRPr`.
  const chain: XmlNode[] = [
    rPr,
    ...propChain.map((n) => child(n, "a:defRPr")),
  ].filter((n): n is XmlNode => n != null);

  const sizeHundredths = firstAttrInt(chain, "sz");
  const bold = firstAttrBool(chain, "b");
  const italic = firstAttrBool(chain, "i");
  const underline = (firstAttr(chain, "u") ?? "none") !== "none";
  const strike = (firstAttr(chain, "strike") ?? "noStrike") !== "noStrike";

  let color: string | null = null;
  for (const node of chain) {
    color = resolveColorChild(child(node, "a:solidFill"), ctx.colors);
    if (color != null) break;
  }
  if (color == null) {
    color = `#${ctx.colors.scheme[ctx.colors.map.tx1 ?? "dk1"] ?? "000000"}`;
  }

  let fontFamily: string | null = null;
  for (const node of chain) {
    const typeface = attr(child(node, "a:latin"), "typeface");
    if (typeface == null) continue;
    fontFamily =
      typeface === "+mj-lt"
        ? ctx.colors.majorFont
        : typeface === "+mn-lt"
          ? ctx.colors.minorFont
          : typeface;
    if (fontFamily != null) break;
  }
  fontFamily ??=
    (phType === "title" || phType === "ctrTitle"
      ? ctx.colors.majorFont
      : ctx.colors.minorFont) ?? null;

  const link = attr(find(rPr, "a:hlinkClick"), "r:id") != null ? "link" : null;

  return {
    text: children(runNode, "a:t")
      .map((t) => t.text)
      .join(""),
    bold: bold ?? undefined,
    italic: italic ?? undefined,
    underline: underline || undefined,
    strike: strike || undefined,
    sizePt: sizeHundredths != null ? sizeHundredths / 100 : undefined,
    color,
    fontFamily: fontFamily ?? undefined,
    link: link ?? undefined,
  };
}

function readBullet(
  propChain: XmlNode[],
  level: number,
  numbering: Map<number, number>,
  hasRuns: boolean
): { glyph: string | null; color: string | null } {
  if (!hasRuns) return { glyph: null, color: null };

  for (const node of propChain) {
    if (child(node, "a:buNone") != null) return { glyph: null, color: null };

    const buChar = child(node, "a:buChar");
    if (buChar != null) {
      numbering.delete(level);
      return { glyph: attr(buChar, "char") ?? "•", color: null };
    }

    const buAutoNum = child(node, "a:buAutoNum");
    if (buAutoNum != null) {
      const start = attrInt(buAutoNum, "startAt") ?? 1;
      const next = (numbering.get(level) ?? start - 1) + 1;
      numbering.set(level, next);
      return {
        glyph: formatAutoNumber(
          attr(buAutoNum, "type") ?? "arabicPeriod",
          next
        ),
        color: null,
      };
    }
  }
  return { glyph: null, color: null };
}

function formatAutoNumber(type: string, value: number): string {
  const toAlpha = (n: number): string => {
    let out = "";
    let rest = n;
    while (rest > 0) {
      const rem = (rest - 1) % 26;
      out = String.fromCharCode(97 + rem) + out;
      rest = Math.floor((rest - 1) / 26);
    }
    return out;
  };
  const toRoman = (n: number): string => {
    const table: Array<[number, string]> = [
      [1000, "m"],
      [900, "cm"],
      [500, "d"],
      [400, "cd"],
      [100, "c"],
      [90, "xc"],
      [50, "l"],
      [40, "xl"],
      [10, "x"],
      [9, "ix"],
      [5, "v"],
      [4, "iv"],
      [1, "i"],
    ];
    let rest = n;
    let out = "";
    for (const [num, sym] of table) {
      while (rest >= num) {
        out += sym;
        rest -= num;
      }
    }
    return out;
  };

  if (type.startsWith("alphaLc"))
    return `${toAlpha(value)}${type.endsWith("ParenR") ? ")" : "."}`;
  if (type.startsWith("alphaUc"))
    return `${toAlpha(value).toUpperCase()}${type.endsWith("ParenR") ? ")" : "."}`;
  if (type.startsWith("romanLc")) return `${toRoman(value)}.`;
  if (type.startsWith("romanUc")) return `${toRoman(value).toUpperCase()}.`;
  if (type.endsWith("ParenR")) return `${value})`;
  if (type.endsWith("ParenBoth")) return `(${value})`;
  return `${value}.`;
}

function firstAttr(nodes: Array<XmlNode | null>, name: string): string | null {
  for (const node of nodes) {
    const value = attr(node, name);
    if (value != null) return value;
  }
  return null;
}

function firstAttrInt(
  nodes: Array<XmlNode | null>,
  name: string
): number | null {
  for (const node of nodes) {
    const value = attrInt(node, name);
    if (value != null) return value;
  }
  return null;
}

function firstAttrBool(
  nodes: Array<XmlNode | null>,
  name: string
): boolean | null {
  for (const node of nodes) {
    const value = attrBool(node, name);
    if (value != null) return value;
  }
  return null;
}

/** Line spacing as a multiplier; point-based spacing is converted at 1.2×/12pt. */
function firstSpacing(
  nodes: Array<XmlNode | null>,
  tag: string
): number | undefined {
  for (const node of nodes) {
    const spc = child(node, tag);
    if (spc == null) continue;
    const pct = attrInt(child(spc, "a:spcPct"), "val");
    if (pct != null) return pct / 100000;
    const pts = attrInt(child(spc, "a:spcPts"), "val");
    if (pts != null) return pts / 100 / 12;
  }
  return undefined;
}

function firstSpacingPoints(
  nodes: Array<XmlNode | null>,
  tag: string
): number | undefined {
  for (const node of nodes) {
    const spc = child(node, tag);
    if (spc == null) continue;
    const pts = attrInt(child(spc, "a:spcPts"), "val");
    if (pts != null) return pts / 100;
    const pct = attrInt(child(spc, "a:spcPct"), "val");
    // A percentage here is of the font size; 18pt is a reasonable stand-in.
    if (pct != null) return (pct / 100000) * 18;
  }
  return undefined;
}

// Colour maths

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex: string): { r: number; g: number; b: number } {
  const clean = hex.replace("#", "").padEnd(6, "0").slice(0, 6);
  return {
    r: Number.parseInt(clean.slice(0, 2), 16) || 0,
    g: Number.parseInt(clean.slice(2, 4), 16) || 0,
    b: Number.parseInt(clean.slice(4, 6), 16) || 0,
  };
}

function rgbToHsl(
  r: number,
  g: number,
  b: number
): { h: number; s: number; l: number } {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return { h: 0, s: 0, l };
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
  else if (max === gn) h = ((bn - rn) / d + 2) / 6;
  else h = ((rn - gn) / d + 4) / 6;
  return { h, s, l };
}

function hslToRgb(
  h: number,
  s: number,
  l: number
): { r: number; g: number; b: number } {
  if (s === 0) {
    const v = Math.round(l * 255);
    return { r: v, g: v, b: v };
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const toChannel = (t: number): number => {
    let tt = t;
    if (tt < 0) tt += 1;
    if (tt > 1) tt -= 1;
    if (tt < 1 / 6) return p + (q - p) * 6 * tt;
    if (tt < 1 / 2) return q;
    if (tt < 2 / 3) return p + (q - p) * (2 / 3 - tt) * 6;
    return p;
  };
  return {
    r: Math.round(toChannel(h + 1 / 3) * 255),
    g: Math.round(toChannel(h) * 255),
    b: Math.round(toChannel(h - 1 / 3) * 255),
  };
}

/** The handful of `a:prstClr` names decks actually use. */
const PRESET_COLORS: Record<string, string> = {
  black: "000000",
  white: "FFFFFF",
  red: "FF0000",
  green: "008000",
  blue: "0000FF",
  yellow: "FFFF00",
  gray: "808080",
  grey: "808080",
  darkGray: "A9A9A9",
  lightGray: "D3D3D3",
  orange: "FFA500",
  purple: "800080",
  cyan: "00FFFF",
  magenta: "FF00FF",
};
