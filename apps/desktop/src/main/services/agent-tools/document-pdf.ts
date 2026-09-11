/**
 * Printing a document to PDF. Separate from the deck exporter: a deck must not
 * reflow, a document must reflow well (margins, page numbers, no stranded
 * headings).
 */
import fs from "fs/promises";
import path from "path";

import { BrowserWindow } from "electron";

export type DocumentPdfOptions = {
  /** Absolute path to the document's HTML file. */
  htmlPath: string;
  /** Where to write the PDF; defaults to the HTML path with a .pdf suffix. */
  outputPath?: string;
  pageSize?: "A4" | "Letter";
  /**
   * No page margins; the document's own padding sets the inset. The only way
   * to print a background colour edge to edge, since Chromium paints the margin
   * and no stylesheet reaches it. Costs the page number, which lives in the
   * margin (see FOOTER_TEMPLATE).
   */
  fullBleed?: boolean;
};

export type DocumentPdfResult = {
  pdfPath: string;
  pages: number;
  bytes: number;
  /**
   * PNG of the first viewport of the printed document, so the caller can look
   * at what it made without paginating the PDF. Null when the capture fails:
   * the PDF is already written and must not be lost over a screenshot.
   */
  previewPath: string | null;
};

const EXPORT_TIMEOUT_MS = 120_000;

/** Wait for webfonts and images, which otherwise silently ruin a capture. */
const AWAIT_READY = `(async () => {
  try { await document.fonts.ready } catch { /* no font API */ }
  await Promise.all([...document.images].map((img) =>
    img.complete ? null : new Promise((resolve) => {
      // addEventListener, not onload/onerror: assigning the properties would
      // clobber handlers the page itself installed.
      img.addEventListener('load', resolve, { once: true });
      img.addEventListener('error', resolve, { once: true });
    })));
  await new Promise((resolve) => setTimeout(resolve, 250));
  return true;
})()`;

/**
 * Page numbers only. There is no running header: Chromium ignores
 * `printToPDF`'s header template, has no `@page` margin boxes or
 * `counter(page)`, and reprints a `position: fixed` element over body text.
 */
const FOOTER_TEMPLATE =
  '<div style="width:100%;padding:0 14mm;text-align:right;font-size:9px;color:#8b9099;">' +
  '<span class="pageNumber"></span>/<span class="totalPages"></span></div>';

/**
 * Counts `/Type /Page` objects (whitespace optional, `/Pages` tree nodes
 * excluded). A valid PDF can defeat the literal scan — compressed object
 * streams hide the markers — so a non-empty document never reports fewer than
 * one page.
 */
const countPages = (pdf: Buffer): number => {
  const text = pdf.toString("latin1");
  const pages = (text.match(/\/Type\s*\/Page\b/g) ?? []).length;
  return pages > 0 ? pages : pdf.length > 0 ? 1 : 0;
};

/**
 * Screenshots the loaded document beside its PDF, after printing so a failed
 * capture cannot cost the document.
 */
const capturePreview = async (
  win: BrowserWindow,
  pdfPath: string
): Promise<string | null> => {
  try {
    const image = await win.webContents.capturePage();
    const target = `${pdfPath.replace(/\.pdf$/i, "")}-preview.png`;

    await fs.writeFile(target, image.toPNG());

    return target;
  } catch {
    return null;
  }
};

export const exportDocumentPdf = async (
  options: DocumentPdfOptions
): Promise<DocumentPdfResult> => {
  const htmlPath = path.resolve(options.htmlPath);
  const stat = await fs.stat(htmlPath).catch(() => null);
  if (stat == null || !stat.isFile())
    throw new Error(`No such HTML file: ${htmlPath}`);

  const pdfPath = path.resolve(
    options.outputPath ?? `${htmlPath.replace(/\.[^./\\]+$/, "")}.pdf`
  );

  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    // Roughly a page wide, so the on-screen layout the model's HTML produces is
    // close to what gets printed.
    width: 794,
    height: 1123,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });

  const timeout = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, EXPORT_TIMEOUT_MS);

  try {
    await win.loadFile(htmlPath);
    await win.webContents.executeJavaScript(AWAIT_READY);

    const bleed = options.fullBleed === true;
    const data = await win.webContents.printToPDF({
      pageSize: options.pageSize ?? "A4",
      printBackground: true,
      // Room for the page number, which prints inside the margin. Zero when
      // bleeding; see `fullBleed`.
      margins: bleed
        ? { top: 0, bottom: 0, left: 0, right: 0 }
        : { top: 0.7, bottom: 0.6, left: 0.75, right: 0.75 },
      displayHeaderFooter: !bleed,
      // An empty header, not an absent one: leaving the template out brings
      // back Chromium's default title-and-date line.
      ...(bleed
        ? {}
        : { headerTemplate: "<span></span>", footerTemplate: FOOTER_TEMPLATE }),
    });

    await fs.writeFile(pdfPath, data);

    const previewPath = await capturePreview(win, pdfPath);

    return {
      pdfPath,
      pages: countPages(data),
      bytes: data.length,
      previewPath,
    };
  } finally {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
  }
};
