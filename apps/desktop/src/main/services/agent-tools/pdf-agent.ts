/**
 * The pdf component, behind one tool. The `document` sub-agent writes content
 * and calls back for `renderDocument`, which takes sections, never a page, so
 * a caller cannot produce a document that fails to lay out. Reading and
 * editing shell out to a bundled Python script (pypdf, pdfplumber).
 */
import { execFile } from "child_process";
import fs from "fs/promises";
import path from "path";
import { promisify } from "util";

import { resourcePath } from "#main/resources";

import { localiseImages, rewriteImageSources } from "./document-images";
import { exportDocumentPdf } from "./document-pdf";
import { ensurePython } from "./python-env";

const execFileAsync = promisify(execFile);

const SCRIPT_TIMEOUT_MS = 120_000;

/** More than this is a book, not a brief. */
const MAX_SECTIONS = 15;

export type DocumentStyle = "report" | "editorial" | "memo";

/** One section as the sub-agent wrote it: a heading, and a body fragment. */
export type DocumentSection = {
  heading: string;
  html: string;
};

/**
 * Appearance as a closed set, so it is answerable: a caller with no parameter
 * edits the stylesheet by hand, which cannot work for a background because the
 * page margins are Chromium's, not the stylesheet's.
 */
export type DocumentTheme = "light" | "dark";
export type DocumentTextSize = "normal" | "large";

export type DocumentTemplateSummary = {
  slug: string;
  name?: string;
  best_for?: string;
  mood?: string;
};

/**
 * The document templates. A template is an override appended to the base
 * stylesheet, not a replacement: the base owns the class contract and the
 * print behaviour (page breaks, repeating table headers), and a template says
 * only palette, type and cover, so a new one cannot break pagination.
 */
export const documentTemplates = async (): Promise<{
  templates: DocumentTemplateSummary[];
}> => {
  const resources = await pdfResourcesDir();
  const index = JSON.parse(
    await fs.readFile(path.join(resources, "templates.json"), "utf8")
  ) as {
    templates: Array<Record<string, unknown>>;
  };

  return {
    templates: index.templates.map((entry) => ({
      slug: String(entry.slug ?? ""),
      ...(entry.name != null ? { name: String(entry.name) } : {}),
      ...(entry.best_for != null ? { best_for: String(entry.best_for) } : {}),
      ...(entry.mood != null ? { mood: String(entry.mood) } : {}),
    })),
  };
};

/** A designed template, not the bare base: undecorated is no choice at all. */
export const DEFAULT_DOCUMENT_TEMPLATE = "atlas";

/**
 * The base stylesheet plus the template's overrides. An unknown slug falls
 * back to the default template, never to the bare base.
 */
const stylesheetFor = async (
  resources: string,
  template: string
): Promise<string> => {
  const dir = path.join(resources, "templates");
  const base = await fs
    .readFile(path.join(dir, "_base.css"), "utf8")
    .catch(
      async () => await fs.readFile(path.join(resources, "styles.css"), "utf8")
    );

  const wanted =
    template.replace(/[^a-z0-9-]/gi, "") || DEFAULT_DOCUMENT_TEMPLATE;
  const read = async (slug: string): Promise<string | null> =>
    await fs.readFile(path.join(dir, `${slug}.css`), "utf8").catch(() => null);

  const override =
    (await read(wanted)) ?? (await read(DEFAULT_DOCUMENT_TEMPLATE));

  return override == null
    ? base
    : `${base}\n\n/* ── ${wanted} ─────────────────────────────── */\n${override}`;
};

/**
 * Copies the bundled faces beside the stylesheet: the page prints from a
 * `file://` URL with no access outside its directory, and a missing webfont
 * silently falls back to the system stack. A failure here prints plainer type.
 */
const copyFonts = async (resources: string, workDir: string): Promise<void> => {
  try {
    const from = path.join(resources, "fonts");
    const to = path.join(workDir, "fonts");

    await fs.mkdir(to, { recursive: true });

    for (const file of await fs.readdir(from)) {
      if (!file.endsWith(".woff2") && !file.startsWith("LICENSE")) continue;

      await fs.copyFile(path.join(from, file), path.join(to, file));
    }
  } catch {
    /* system stacks it is */
  }
};

export type RenderDocumentRequest = {
  outputPath: string;
  title: string;
  standfirst: string;
  style: DocumentStyle;
  sections: DocumentSection[];
  theme?: DocumentTheme;
  textSize?: DocumentTextSize;
  /** Visual identity, from `documentTemplates`. */
  template?: string;
};

export type RenderDocumentResult = {
  pdfPath: string;
  htmlPath: string;
  template: string;
  /** PNG of the printed page, for checking the work. */
  previewPath: string | null;
  pages: number;
  sections: number;
  images: number;
  /** One line per image that could not be printed, and why. */
  droppedImages: string[];
  style: DocumentStyle;
  theme: DocumentTheme;
  textSize: DocumentTextSize;
  seconds: number;
};

/**
 * `bleed` rides with `dark`: a background colour without full-bleed printing
 * comes out framed in white, so the two are one decision.
 */
const bodyClasses = (
  style: DocumentStyle,
  theme: DocumentTheme,
  textSize: DocumentTextSize
): string =>
  [
    style,
    ...(theme === "dark" ? ["dark", "bleed"] : []),
    ...(textSize === "large" ? ["large"] : []),
  ].join(" ");

/**
 * Read back from the file rather than remembered: `reprint` gets documents it
 * did not render, possibly hand-edited.
 */
const wantsFullBleed = (html: string): boolean =>
  /<body[^>]*\bclass\s*=\s*("|')[^"']*\bbleed\b/i.test(html);

// ---------------------------------------------------------------------------
// Resources
// ---------------------------------------------------------------------------

const pdfResourcesDir = async (): Promise<string> => {
  const dir = resourcePath("pdf");
  const present = await fs
    .stat(path.join(dir, "styles.css"))
    .then(() => true)
    .catch(() => false);

  if (!present) {
    throw new Error("The bundled PDF resources are missing from this build.");
  }

  return dir;
};

// ---------------------------------------------------------------------------
// Safety: the sections are untrusted markup
// ---------------------------------------------------------------------------

/**
 * Model-written HTML loaded into a real page is untrusted: scripts, styles,
 * iframes, event handlers and `javascript:` URLs are removed at this boundary
 * rather than relied on not to appear.
 */
const ALLOWED_TAGS = new Set([
  "h2",
  "h3",
  "h4",
  "p",
  "ul",
  "ol",
  "li",
  "strong",
  "em",
  "b",
  "i",
  "code",
  "pre",
  "br",
  "hr",
  "blockquote",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "div",
  "span",
  "a",
  "small",
  "sup",
  "sub",
  // A picture in a document is normally a captioned one.
  "img",
  "figure",
  "figcaption",
]);

/**
 * A local file or inlined bytes. Remote URLs are refused: printing fetches
 * whatever src points at, which would let a page the model just read pick a
 * host to call at print time.
 */
const isPrintableImageSrc = (src: string): boolean => {
  const value = src.trim().toLowerCase();
  if (value.startsWith("data:image/")) return true;
  if (value.startsWith("file:")) return true;
  // "C:\chart.png" is a local file, not a one-letter scheme.
  if (/^[a-z]:[\\/]/.test(value)) return true;
  // A bare relative path resolves next to the HTML being printed.
  return !/^[a-z][a-z0-9+.-]*:/.test(value) && !value.startsWith("//");
};

/** Drop an `<img>` whose source is not printable, rather than print a gap. */
const stripUnprintableImages = (html: string): string =>
  html.replace(/<img\b[^>]*>/gi, (tag) => {
    const src = /\ssrc\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(tag);
    const value = src?.[2] ?? src?.[3] ?? src?.[4] ?? "";
    return value.length > 0 && isPrintableImageSrc(value) ? tag : "";
  });

export const sanitizeHtml = (html: string): string =>
  stripUnprintableImages(html)
    .replace(
      /<(script|style|iframe|object|embed|link|meta)\b[\s\S]*?<\/\1>/gi,
      ""
    )
    .replace(/<(script|style|iframe|object|embed|link|meta)\b[^>]*\/?>/gi, "")
    // Event handlers and javascript: URLs.
    .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, "")
    .replace(/(href|src)\s*=\s*("|')\s*javascript:[^"']*\2/gi, '$1="#"')
    // Anything outside the allow-list loses its tags but keeps its text.
    .replace(/<\/?([a-zA-Z][\w-]*)\b[^>]*>/g, (tag, name: string) =>
      ALLOWED_TAGS.has(name.toLowerCase()) ? tag : ""
    );

/**
 * A sub-heading repeating the section's own heading is dropped: models restate
 * it no matter how firmly the prompt says not to.
 */
const dropEchoedHeading = (body: string, heading: string): string => {
  const normalise = (value: string): string =>
    value
      .replace(/<[^>]+>/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  return body.replace(
    /^\s*<h([34])\b[^>]*>([\s\S]*?)<\/h\1>/i,
    (whole, _level, text: string) =>
      normalise(text) === normalise(heading) ? "" : whole
  );
};

// ---------------------------------------------------------------------------
// Creating
// ---------------------------------------------------------------------------

const escapeHtml = (value: string): string =>
  value.replace(
    /[&<>"]/g,
    (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[ch] ?? ch
  );

/**
 * A model-chosen output path may be a file the user already has. Our own
 * output is recognised by the sibling source directory and the file inside
 * it; the inner file matters because the directory name alone is a coincidence
 * anyone could have.
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

/**
 * Assembles a document from its sections and prints it. No model calls, no
 * state between calls. The shell, stylesheet, cover and heading levels are
 * decided here, not arguments, so a caller cannot express a document that
 * fails to lay out.
 */
export const renderDocument = async (
  request: RenderDocumentRequest
): Promise<RenderDocumentResult> => {
  const startedAt = Date.now();

  const title = request.title.trim().slice(0, 160);
  if (title.length === 0) throw new Error("A document needs a title.");

  const sections = request.sections
    .filter(
      (section) =>
        typeof section?.heading === "string" &&
        typeof section?.html === "string"
    )
    .slice(0, MAX_SECTIONS);
  if (sections.length === 0)
    throw new Error("A document needs at least one section.");

  const style: DocumentStyle = (
    ["report", "editorial", "memo"] as const
  ).includes(request.style)
    ? request.style
    : "report";
  const theme: DocumentTheme = request.theme === "dark" ? "dark" : "light";
  const textSize: DocumentTextSize =
    request.textSize === "large" ? "large" : "normal";
  const standfirst = (request.standfirst ?? "").trim().slice(0, 400);

  // Worked out before anything is written, so a refused path is refused
  // before the first mkdir.
  const outputPath = path.resolve(request.outputPath);
  const outputDir = path.dirname(outputPath);
  const workDir = path.join(
    outputDir,
    `${path.basename(outputPath).replace(/\.[^./\\]+$/, "")}-source`
  );
  const pdfPath = outputPath.toLowerCase().endsWith(".pdf")
    ? outputPath
    : `${outputPath.replace(/\.[^./\\]+$/, "")}.pdf`;
  await refuseForeignOverwrite(pdfPath, workDir, "document.html");

  const resources = await pdfResourcesDir();

  const template =
    (request.template ?? DEFAULT_DOCUMENT_TEMPLATE).trim() ||
    DEFAULT_DOCUMENT_TEMPLATE;

  await fs.mkdir(workDir, { recursive: true });
  await fs.writeFile(
    path.join(workDir, "styles.css"),
    await stylesheetFor(resources, template),
    "utf8"
  );
  await copyFonts(resources, workDir);

  // Remote images are fetched beside the HTML before sanitizing, so the
  // printer only ever sees local files; failures are reported, not dropped.
  const images = await localiseImages(
    sections.map((section) => section.html),
    workDir
  );

  const bodies = sections.map((section) =>
    dropEchoedHeading(
      sanitizeHtml(rewriteImageSources(section.html, images.localised)),
      section.heading
    )
  );

  const dateLine = new Date().toLocaleDateString("en-GB", {
    year: "numeric",
    month: "long",
    day: "numeric",
  });
  // The HTML comment is for whoever edits the source and reprints: the body
  // classes and the role of `bleed` cannot be guessed from the markup.
  const html = `<!doctype html>
<html lang="en">
<!--
  Edit this file and reprint it (pdf action "reprint") to change the document.

  The <body> class list is the whole of its appearance:
    report | editorial | memo   the look
    dark                        light text on a dark page
    bleed                       print to the page edge, no margins, no page
                                numbers. REQUIRED with "dark": the page margins
                                are painted by the printer, not by styles.css, so
                                a dark page without "bleed" comes out framed in
                                white.
    large                       bigger type, for reading on a screen

  styles.css beside this file is a copy — edit it freely, it affects only this
  document. Section bodies are sanitized on render: scripts, styles and unknown
  tags are stripped, so add content with the tags already used here.
-->
<head>
<meta charset="utf-8" />
<title>${escapeHtml(title)}</title>
<link rel="stylesheet" href="styles.css" />
</head>
<body class="${bodyClasses(style, theme, textSize)}">
<article class="doc">
  <header class="cover${style === "memo" ? " compact" : ""}">
    <div class="eyebrow">${escapeHtml(style === "memo" ? "Memo" : "Document")}</div>
    <h1>${escapeHtml(title)}</h1>
    ${standfirst.length > 0 ? `<p class="standfirst">${escapeHtml(standfirst)}</p>` : ""}
    <div class="meta"><span>${escapeHtml(dateLine)}</span></div>
  </header>
${sections.map((section, index) => `  <section>\n    <h2>${escapeHtml(section.heading)}</h2>\n${bodies[index]}\n  </section>`).join("\n")}
</article>
</body>
</html>
`;

  const htmlPath = path.join(workDir, "document.html");
  await fs.writeFile(htmlPath, html, "utf8");

  // The HTML is already openable, so a failed export says where it is.
  const exported = await exportDocumentPdf({
    htmlPath,
    outputPath: pdfPath,
    ...(theme === "dark" ? { fullBleed: true } : {}),
  }).catch((error: unknown) => {
    throw new Error(
      `the document was written to ${htmlPath} but the PDF export failed: ${(error as Error)?.message ?? "unknown error"}`
    );
  });

  return {
    pdfPath: exported.pdfPath,
    htmlPath,
    template,
    previewPath: exported.previewPath,
    pages: exported.pages,
    sections: sections.length,
    images: images.localised.size,
    droppedImages: images.dropped,
    style,
    theme,
    textSize,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
};

// ---------------------------------------------------------------------------
// Re-printing
// ---------------------------------------------------------------------------

export type PdfReprintResult = {
  pdfPath: string;
  htmlPath: string;
  previewPath: string | null;
  pages: number;
  bytes: number;
  seconds: number;
};

/**
 * The PDF a `document.html` was printed to: `create` writes
 * `<name>-source/document.html` beside `<name>.pdf`. Other HTML prints beside
 * itself.
 */
const printedTo = (htmlPath: string): string => {
  const sourceDir = path.dirname(htmlPath);
  const name = path.basename(sourceDir);
  const suffix = "-source";

  return name.endsWith(suffix)
    ? path.join(path.dirname(sourceDir), `${name.slice(0, -suffix.length)}.pdf`)
    : `${htmlPath.replace(/\.[^./\\]+$/, "")}.pdf`;
};

/**
 * Prints a document from HTML that already exists, which is what makes "edit
 * the source" a real operation. The default destination is the PDF that HTML
 * was printed to; a different `outputPath` is honoured, but an existing file
 * there is somebody else's PDF and is refused. The HTML need not be ours.
 */
export const reprintPdf = async (request: {
  htmlPath: string;
  outputPath?: string;
}): Promise<PdfReprintResult> => {
  const startedAt = Date.now();
  const htmlPath = path.resolve(request.htmlPath);

  if (!/\.html?$/i.test(htmlPath)) {
    throw new Error(
      `reprint takes the document's HTML file; ${path.extname(htmlPath) || "that path"} is not one: ${htmlPath}`
    );
  }

  const fallback = printedTo(htmlPath);
  const requested = (request.outputPath ?? "").trim();
  const pdfPath =
    requested.length === 0
      ? fallback
      : path.resolve(
          requested.toLowerCase().endsWith(".pdf")
            ? requested
            : `${requested.replace(/\.[^./\\]+$/, "")}.pdf`
        );

  // Only the document this HTML belongs to may be replaced without question.
  if (pdfPath !== fallback) {
    const occupied = await fs
      .stat(pdfPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (occupied) {
      throw new Error(
        `${pdfPath} already exists. Omit output_path to update the document this HTML was printed to, ` +
          "or choose a path that does not exist yet."
      );
    }
  }

  const exported = await exportDocumentPdf({
    htmlPath,
    outputPath: pdfPath,
    ...(wantsFullBleed(await fs.readFile(htmlPath, "utf8"))
      ? { fullBleed: true }
      : {}),
  });

  return {
    pdfPath: exported.pdfPath,
    htmlPath,
    previewPath: exported.previewPath,
    pages: exported.pages,
    bytes: exported.bytes,
    seconds: Math.round((Date.now() - startedAt) / 100) / 10,
  };
};

// ---------------------------------------------------------------------------
// Reading and editing
// ---------------------------------------------------------------------------

export type PdfScriptResult = Record<string, unknown> & { ok: boolean };

/**
 * Runs a subcommand of the bundled script, on the app's own Python
 * environment, so nobody runs pip before reading a PDF.
 */
export const runPdfScript = async (
  args: string[]
): Promise<PdfScriptResult> => {
  const resources = await pdfResourcesDir();
  const script = path.join(resources, "scripts", "pdf_ops.py");

  // Heavier libraries are installed only for the actions that need them.
  const imports =
    args[0] === "tables"
      ? ["pypdf", "pdfplumber"]
      : args[0] === "stamp"
        ? ["pypdf", "reportlab"]
        : ["pypdf"];

  let env;
  try {
    env = await ensurePython(imports);
  } catch (error) {
    return { ok: false, error: (error as Error).message };
  }

  try {
    const { stdout } = await execFileAsync(env.python, [script, ...args], {
      timeout: SCRIPT_TIMEOUT_MS,
      maxBuffer: 32 * 1024 * 1024,
    });
    const parsed = JSON.parse(stdout) as PdfScriptResult;
    return env.installed.length > 0
      ? { ...parsed, installed: env.installed }
      : parsed;
  } catch (error) {
    const stdout = (error as { stdout?: string }).stdout ?? "";
    if (stdout.trim().startsWith("{")) {
      try {
        return JSON.parse(stdout) as PdfScriptResult;
      } catch {
        /* fall through */
      }
    }
    return { ok: false, error: (error as Error).message.slice(0, 400) };
  }
};
