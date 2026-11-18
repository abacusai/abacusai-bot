/**
 * Making a document or deck from the model's HTML with the design system:
 * sums and charts in code, a floor on text size, posters and slides shrunk to
 * fit, printed by the app's own printers (exportDocumentPdf / exportDeckPdf),
 * read back, and printed again smaller when a page is blank, a last page
 * holds only a few lines, or a one-pager runs to two. Word comes from the same
 * page.
 */
import fs from "fs/promises";
import path from "path";

import { BrowserWindow } from "electron";
import { getDocumentProxy } from "unpdf";

import { resourcePath } from "#main/resources";

import { exportDeckPdf } from "../deck-pdf";
import { shootRegion } from "../deck-pptx-export";
import { exportDocumentPdf } from "../document-pdf";
import type { Ask } from "./ask";
import { drawCharts, missingChart } from "./charts";
import { DOC_TYPES, designsOf, docTypeOf, type DocType } from "./designs";
import { buildDocx, collectBlocks, type Block } from "./docx-export";
import { dropNumbers } from "./drop";
import {
  briefFigures,
  briefValues,
  sharesNotGiven,
  unsupportedNumbers,
} from "./faithful";
import {
  describeIssues,
  fitInWindow,
  forcedStartsIn,
  judgePages,
  type PageIssue,
} from "./fit";
import {
  PAGE_NUMBERS_CSS,
  bundledOnly,
  fontsInPdf,
  foreignFonts,
} from "./fonts";
import {
  brokenImages,
  layoutProblems,
  numberAgenda,
  ownStylesOnly,
  cvAside,
  repeatedNumbers,
  spaceGluedWords,
  tableColumns,
} from "./layout";
import { pageFor } from "./page";
import { readBack } from "./readback";
import { applySums, type SumsReport } from "./sums";

export type MakeResult = {
  pdfPath: string | null;
  pptxPath: string | null;
  docxPath: string | null;
  pages: number;
  sums: SumsReport;
  /** Fonts in the PDF the app does not ship (should be none). */
  foreignFonts: string[];
  /** Blocks left out on the last attempt for holding numbers nobody gave. */
  dropped: string[];
  /** What to send back to the model, once: wrong marks, broken charts, pages that would not fit, text that did not print. */
  sendBack: string[];
  /** Text over text or a chart, out of its box, or loose on a slide. */
  layout: string[];
  /** Images that did not load. */
  images: string[];
  /** The last print still had layout problems: no file is handed over. */
  failed: string[];
};

type ChartsReport = ReturnType<typeof drawCharts>;

/** A page that never settles is closed, so its window does not outlive the ask (as deck-pdf.ts). */
const PREPARE_TIMEOUT_MS = 120_000;

const READY = `(async () => { try { await document.fonts.ready } catch {} await Promise.all([...document.images].map((i) => i.complete ? null : new Promise((r) => { i.addEventListener('load', r); i.addEventListener('error', r); setTimeout(r, 10000) }))); await new Promise((r) => setTimeout(r, 200)); return true })()`;

/** Copies the stylesheet and fonts beside the HTML, which links "system.css". */
export const placeSystem = async (dir: string): Promise<void> => {
  const from = resourcePath("docs-system");
  await fs.cp(from, dir, {
    recursive: true,
    force: true,
    filter: (src) => !src.endsWith(".md"),
  });
};

/** How far down each page the text reaches (0 to 1), the page number aside. */
export const pdfUsedHeights = async (pdfPath: string): Promise<number[]> => {
  const pdf = await getDocumentProxy(
    new Uint8Array(await fs.readFile(pdfPath))
  );
  const out: number[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const height = page.getViewport({ scale: 1 }).height;
    const ys = (await page.getTextContent()).items
      .filter(
        (item) =>
          "str" in item &&
          item.str.trim() !== "" &&
          !/^\s*\d+\s*\/\s*\d+\s*$/.test(item.str)
      )
      .map((item) => (item as { transform: number[] }).transform[5] ?? height)
      // The printed page number sits in the bottom margin (0.6 in = 43 pt).
      .filter((y) => y > 45);
    out.push(ys.length ? (height - Math.min(...ys)) / height : 0);
  }
  return out;
};

export const pdfPageTexts = async (pdfPath: string): Promise<string[]> => {
  const pdf = await getDocumentProxy(
    new Uint8Array(await fs.readFile(pdfPath))
  );
  const pages: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const content = await (await pdf.getPage(i)).getTextContent();
    pages.push(
      content.items
        .map((item) =>
          "str" in item
            ? item.str + ((item as { hasEOL?: boolean }).hasEOL ? "\n" : " ")
            : ""
        )
        .join("")
    );
  }
  return pages;
};

type Prepared = {
  sums: SumsReport;
  charts: ChartsReport;
  fitted: ReturnType<typeof fitInWindow>;
  text: string;
  blocks: Block[] | null;
  bleed: boolean;
  landscape: boolean;
  dropped: string[];
  forcedStarts: Array<{ text: string; kind: "cover" | "key" | "section" }>;
  figureTexts: string[][];
  layout: string[];
  repeats: string[];
  images: string[];
  sparse: string[];
};

/** Each picture block with its shot (PNG) and printed size; unshot ones as they were. */
const shootPictures = async (
  win: BrowserWindow,
  blocks: Block[]
): Promise<Block[]> => {
  const out: Block[] = [];
  for (const b of blocks) {
    if (b.t !== "picture") {
      out.push(b);
      continue;
    }
    const rect = (await win.webContents.executeJavaScript(
      `(() => { const el = document.querySelector('[data-shot="${b.shot}"]'); if (!el) return null; const r = el.getBoundingClientRect(); return { pageX: r.left + window.scrollX, pageY: r.top + window.scrollY, w: r.width, h: r.height } })()`
    )) as { pageX: number; pageY: number; w: number; h: number } | null;
    const uri =
      rect != null && rect.w >= 4 && rect.h >= 4
        ? await shootRegion(win, rect)
        : null;
    out.push(
      uri == null || rect == null
        ? b
        : {
            ...b,
            data: Buffer.from(uri.slice(uri.indexOf(",") + 1), "base64"),
            w: rect.w,
            h: rect.h,
          }
    );
  }
  return out;
};

/** The document looks (system.css, data-look); "classic" is the sheet's own. */
export const DOC_LOOKS = [
  "classic",
  "editorial",
  "bold",
  "minimal",
  "warm",
  "midnight",
] as const;

/** A listed design the request names by id ("resume-ledger") or name ("the Ledger design"). */
const namedDesign = (said: string, own?: DocType): string | null => {
  // Accents aside: "Soiree design" names the Soirée design.
  const plain = (value: string): string =>
    value.normalize("NFD").replace(/\p{M}/gu, "");
  const text = plain(said);
  // The page's own type first: two types may share a design's name (Studio).
  if (/\bclassic\s+(design|layout)\b/i.test(text)) return "classic";
  const types =
    own == null ? DOC_TYPES : [own, ...DOC_TYPES.filter((t) => t !== own)];
  for (const type of types)
    for (const d of designsOf(type))
      if (
        new RegExp(`\\b${d.id}\\b`, "i").test(text) ||
        new RegExp(
          `\\b${plain(d.name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s+(design|template|look)\\b`,
          "i"
        ).test(text)
      )
        return d.id;
  return null;
};

/** The document look a request names: "in the Editorial look", "Look: warm". */
const namedLook = (text: string): string | null =>
  /\b(classic|editorial|bold|minimal|warm|midnight)\s+look\b|\blook:?\s+(classic|editorial|bold|minimal|warm|midnight)\b/i
    .exec(text)
    ?.slice(1)
    .find((m) => m != null)
    ?.toLowerCase() ?? null;

/** Loads the source, applies sums, charts and fitting at type scale `fit`, and writes the page to print. */
const prepare = async (
  sourcePath: string,
  printPath: string,
  kind: "doc" | "deck",
  ask: Ask,
  o: {
    fit: number;
    wantBlocks: boolean;
    briefNumbers: number[];
    drop: string[];
    dropFailedCharts: boolean;
    relief: number;
    /** A look the user named ("in the Warm look"): it wins over the page's own. */
    look: string | null;
    /** A design chosen by name (the templates page, "Try another look"). */
    design: string | null;
    /** A résumé whose name nobody gave: it prints as a sample (Your Name). */
    sampleName?: boolean;
    /** A sample résumé: its bracketed blanks are left out, so it reads finished. */
    sampleCv?: boolean;
    /** Blanks print as highlighted [placeholders] in the text, not ruled lines. */
    inlineBlanks?: boolean;
  }
): Promise<Prepared> => {
  const { fit, wantBlocks } = o;
  const win = new BrowserWindow({
    show: false,
    useContentSize: true,
    width: kind === "deck" ? 1280 : 794,
    height: kind === "deck" ? 720 : 1123,
    webPreferences: { nodeIntegration: false, contextIsolation: true },
  });
  const timeout = setTimeout(() => {
    if (!win.isDestroyed()) win.destroy();
  }, PREPARE_TIMEOUT_MS);
  try {
    await win.loadFile(sourcePath);
    await win.webContents.executeJavaScript(READY);
    const run = <T>(
      fn: (...a: never[]) => unknown,
      ...args: unknown[]
    ): Promise<T> =>
      win.webContents.executeJavaScript(
        `(${fn.toString()})(${["document", ...args.map((a) => JSON.stringify(a))].join(", ")})`
      ) as Promise<T>;
    // Forms (quotes, letters, minutes) keep the smaller body size, so they fit
    // their page; reports and teaching material get the larger one.
    await win.webContents.executeJavaScript(
      `document.body.classList.add('genre-${ask.genre}');${ask.plain && kind === "doc" ? "document.body.classList.add('plain');" : ""}`
    );
    // The templates gallery asks for a look by name: it is the user's choice.
    if (o.look != null)
      await win.webContents.executeJavaScript(
        o.look === "classic"
          ? "document.documentElement.removeAttribute('data-look')"
          : `document.documentElement.setAttribute('data-look', ${JSON.stringify(o.look)})`
      );
    // "[Employee name]" left for the user prints as a fill-in line with its
    // label, not as bracketed text (comparison, 17 Nov).
    // A résumé for a name the user never gave is a sample: "Your Name", not a
    // made-up person (live m02/e3: the bot's brief named "Arjun Mehta").
    if (o.sampleName === true)
      await win.webContents.executeJavaScript(
        "(() => { const h = document.querySelector('.cv-head h1'); if (h) h.textContent = 'Your Name'; const c = document.querySelector('.cv-head .contact'); if (c) c.textContent = 'City · you@example.com · Phone'; })()"
      );
    // A sample résumé reads finished: "[College]" and the like are left out
    // with their separators, and a line left empty goes (live e3/m02: two
    // pages of fill-in lines).
    if (o.sampleCv === true)
      await win.webContents.executeJavaScript(`(() => {
        const name = document.querySelector('.cv-head h1, h1');
        if (name && name.textContent.includes('[')) name.textContent = 'Your Name';
        const contact = document.querySelector('.cv-head .contact, .doc-head p.small, .doc-head .contact');
        if (contact && (contact.textContent.includes('[') || contact.querySelector('.blank'))) contact.textContent = 'City · you@example.com · Phone';
        // Fill-in lines the model wrote itself go too, with the separators they leave.
        const parents = new Set();
        for (const b of [...document.querySelectorAll('.blank')]) {
          if (b.parentElement) parents.add(b.parentElement);
          b.remove();
        }
        for (const parent of parents)
          parent.innerHTML = parent.innerHTML.replace(/(\\s*[|·,–—\\/-]\\s*){2,}/g, ' · ').replace(/^\\s*[|·,–—\\/:-]\\s*|\\s*[|·,–—\\/:-]\\s*$/g, '');
        // A bracket holding an example keeps its words ("[e.g., CTET / TET]",
        // "[English]"); a generic label ("[Institution]", "[Year]") goes.
        const GENERIC = /^(your |the |e\\.g\\.,? )?(full )?(name|other|institution|school|college|university|board|degree|year|month|city|state|country|subject|subjects?\\(s\\)|grade|grade level|class|number|phone|phone number|email|email address|date|company|employer|notice period|activity|club|event|location|address|linkedin|portfolio|course|percentage|cgpa|score|x)\\b/i;
        const keepExample = (all, inner) => {
          const t = inner.replace(/^e\\.g\\.,?\\s*/i, '').trim();
          return /^e\\.g\\./i.test(inner) || (!GENERIC.test(t) && !/[\\/(]|\\bor\\b/i.test(t) && t.split(/\\s+/).length <= 3 && /^[A-Z]/.test(t)) ? (all.match(/^\\s*[,·|–—:-]?\\s*/)[0] + t) : all;
        };
        const re = /\\s*[,·|–—:-]?\\s*\\[[^\\[\\]\\n]{1,90}\\]|\\bX{1,2}(\\.X{1,2})?\\s*(\\/\\s*\\d+|%)/g;
        const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
        const hits = [];
        for (let n = walk.nextNode(); n; n = walk.nextNode()) if (/\\[[^\\]]+\\]|\\bX{1,2}(\\.X{1,2})?\\s*(\\/|%)/.test(n.nodeValue)) hits.push(n);
        for (const n of hits)
          n.nodeValue = n.nodeValue.replace(/\\s*[,·|–—:-]?\\s*\\[([^\\[\\]\\n]{1,90})\\]/g, keepExample).replace(re, '').replace(/^\\s*[,·|–—:-]\\s*/, '').replace(/\\(\\s*[,;·|–—-]?\\s*\\)/g, '').replace(/\\(\\s*[,;]\\s*/g, '(').replace(/\\s+,/g, ',');
        // A table column left empty goes, then a row left empty.
        for (const table of document.querySelectorAll('table')) {
          const rows = [...table.rows];
          const width = Math.max(0, ...rows.map((r) => r.cells.length));
          for (let c = width - 1; c >= 0; c--)
            if (rows.slice(1).every((r) => (r.cells[c]?.textContent ?? '').trim() === ''))
              rows.forEach((r) => r.cells[c]?.remove());
          for (const r of rows.slice(1)) if (r.textContent.trim() === '') r.remove();
        }
        for (const el of [...document.querySelectorAll('li, p, h3, .org')].reverse())
          if (!el.querySelector('img, svg') && el.textContent.replace(/[\\s,·|–—:()\\-]/g, '') === '') el.remove();
        // A sample is one page: four sections, two entries a section, one bullet each.
        for (const h of [...document.querySelectorAll('.cv-body > main > h2')].slice(4)) {
          for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; ) {
            const next = el.nextElementSibling;
            el.remove();
            el = next;
          }
          h.remove();
        }
        for (const h of document.querySelectorAll('.cv-body > main > h2')) {
          let n = 0;
          for (let el = h.nextElementSibling; el && el.tagName !== 'H2'; ) {
            const next = el.nextElementSibling;
            if (el.classList.contains('job') && (el.textContent.trim() === '' || ++n > 2)) el.remove();
            el = next;
          }
        }
        // One bullet an entry when there are many entries, two when few: a
        // two-job sample cut to one bullet each read thin (master's read, m12).
        const keep = document.querySelectorAll('.cv-body main .job').length > 3 ? 1 : 2;
        for (const u of document.querySelectorAll('.cv-body main .job ul')) [...u.children].slice(keep).forEach((li) => li.remove());
        for (const el of [...document.querySelectorAll('li, p')]) if (/^[^:]{1,30}:\\s*$/.test(el.textContent.trim())) el.remove();
        for (const u of [...document.querySelectorAll('ul, ol')]) if (u.children.length === 0) u.remove();
        for (const h of [...document.querySelectorAll('h2')])
          if (h.nextElementSibling == null || h.nextElementSibling.tagName === 'H2') h.remove();
      })()`);
    // A poster or invitation prints edge to edge even when the model left out
    // body.bleed (the Vows invitation printed as a plain page, 17 Nov).
    if (kind === "doc")
      await win.webContents.executeJavaScript(
        // A poster the model wrapped in a div of its own is unwrapped first
        // (m13: a .card-wrap round the invitation printed it as a plain page).
        "(() => { for (const p of document.querySelectorAll('body > * > .poster')) { const w = p.parentElement; if (w.children.length === 1) w.replaceWith(p); } document.querySelector('body > .poster') && document.body.classList.add('bleed'); })()"
      );
    await win.webContents.executeJavaScript(`(() => {
      const re = /\\[([A-Za-z\\u00C0-\\u024F\\u0900-\\u097F\\u0980-\\u09FF][^\\[\\]\\n]{1,40})\\]|_{4,}/g;
      const walk = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
      const hits = [];
      for (let n = walk.nextNode(); n; n = walk.nextNode())
        if (!n.parentElement.closest('script,style,.blank') && new RegExp(re.source).test(n.nodeValue)) hits.push(n);
      for (const n of hits) {
        const frag = document.createDocumentFragment();
        let last = 0;
        n.nodeValue.replace(re, (all, label, at) => {
          frag.append(n.nodeValue.slice(last, at));
          const b = document.createElement('span');
          b.className = label ? 'blank' : 'blank bare';
          b.textContent = label ? label.trim() : '';
          frag.append(b);
          last = at + all.length;
          return all;
        });
        frag.append(n.nodeValue.slice(last));
        n.replaceWith(frag);
      }
      // A letter, flyer, proposal or report reads as sample wording with a few
      // highlighted [placeholders], not a form of ruled lines (master's read,
      // m06 and m08); certificates, invitations and invoices keep the lines.
      if (${o.inlineBlanks === true})
        for (const b of document.querySelectorAll('.blank:not(.bare)'))
          if (!b.closest('.signs, table') && b.textContent.trim() !== '') b.classList.add('inline');
      // A quiz's compact cover already carries its title: a page header the
      // model wrote beside it with the same title goes (master's read, u02).
      const coverTitle = document.querySelector('body.plain .cover h1');
      if (coverTitle)
        for (const h of document.querySelectorAll('body.plain .doc-head h1'))
          {
            const a = h.textContent.trim().toLowerCase();
            const b = coverTitle.textContent.trim().toLowerCase();
            if (a && (a === b || a.includes(b) || b.includes(a))) (h.closest('.doc-head') ?? h).remove();
          }
      // A signature or date line has one label: its caption. The model's own
      // line label, "Date:" and a second line go (master's read: "DATE" over
      // "Date" on every certificate).
      for (const d of document.querySelectorAll('.signs > div')) {
        const lines = [...d.querySelectorAll('.blank')];
        if (lines.length === 0) continue;
        const caption = [...d.children].filter((c) => !c.classList.contains('blank')).pop();
        for (const t of [...d.childNodes]) if (t.nodeType === 3) t.remove();
        const label = lines[0].textContent;
        // The block's own rule is the line to sign on.
        lines.forEach((b) => b.remove());
        if (caption == null || caption.textContent.trim() === '')
          d.append(Object.assign(document.createElement('span'), { textContent: label.trim() || 'Signature' }));
      }
    })()`);
    if (o.design != null)
      await win.webContents.executeJavaScript(
        o.design === "classic"
          ? "document.documentElement.removeAttribute('data-design')"
          : `document.documentElement.setAttribute('data-design', ${JSON.stringify(o.design)})`
      );
    // A document shrinks as a whole page (type and spacing) with zoom; a
    // deck's slides and posters fit one by one with --fit (fitInWindow).
    // Page balance: 1 lets big blocks break across pages, 2 also shortens charts.
    if (o.relief >= 1)
      await win.webContents.executeJavaScript(
        `document.body.classList.add('relaxed');${o.relief >= 2 ? "document.documentElement.style.setProperty('--chart-fit', '0.7');" : ""}`
      );
    if (kind === "doc" && fit !== 1)
      await win.webContents.executeJavaScript(
        `document.body.classList.contains('bleed') || (document.body.style.zoom = '${fit}')`
      );
    // Only the app's own fonts: the model's own font choices become the
    // bundled stacks (live F: Arial and sans-serif fell to VM fonts).
    // Measure at the printed column's width (A4 less 0.75 in each side), not
    // the window's: a tile that fits on screen overflowed in print (live F2).
    if (kind === "doc") {
      const [bleedPage, landscapePage] =
        (await win.webContents.executeJavaScript(
          "[document.body.classList.contains('bleed'), document.body.classList.contains('landscape')]"
        )) as [boolean, boolean];
      const { window: size } = pageFor({
        bleed: bleedPage,
        landscape: landscapePage,
      });
      win.setContentSize(size.width, size.height);
      await win.webContents.executeJavaScript(
        "new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))"
      );
    }
    await run<number>(ownStylesOnly as never);
    await run<number>(cvAside as never);
    await run<number>(bundledOnly as never);
    // "Presented by<b>Group 4</b>" printed as one word (round 5).
    await run<number>(spaceGluedWords as never);
    // An agenda's numbers as text, for the .pptx (overnight).
    await run<number>(numberAgenda as never);
    // A document draws its own page numbers, in Inter (not Chromium's footer).
    if (kind === "doc")
      await win.webContents.executeJavaScript(
        `document.body.classList.contains('bleed') || document.head.insertAdjacentHTML('beforeend', ${JSON.stringify(`<style id="page-numbers">${PAGE_NUMBERS_CSS}</style>`)})`
      );
    const sums = await run<SumsReport>(applySums as never, {
      totalMarks: ask.totalMarks,
      briefNumbers: o.briefNumbers,
    });
    const charts = await run<ChartsReport>(drawCharts as never);
    const dropped =
      o.drop.length > 0
        ? await run<string[]>(dropNumbers as never, o.drop)
        : [];
    // The last attempt: a diagram that still contradicts its own lines is left
    // out (round 3: an equilibrium marked off the supply line, twice).
    if (o.dropFailedCharts)
      dropped.push(
        ...((await win.webContents.executeJavaScript(
          "[...document.querySelectorAll('figure[data-chart-failed]')].map((f) => { const t = (f.querySelector('figcaption')?.textContent || 'a diagram').trim(); f.remove(); return 'chart: ' + t; })"
        )) as string[])
      );
    // Empty comparison columns go, mostly empty ones are sent back; before the Word copy.
    const { sparse } = await run<{ dropped: string[]; sparse: string[] }>(
      tableColumns as never
    );
    let blocks = wantBlocks ? await run<Block[]>(collectBlocks as never) : null;
    const fitted = await run<ReturnType<typeof fitInWindow>>(
      fitInWindow as never,
      { minFit: kind === "deck" ? 0.72 : 0.78, maxFit: 1.4 }
    );
    // Measured after every change to the layout: text over text or a chart is
    // a failed print, not a style note (live F2: notes printed over cards).
    const layout = await run<string[]>(layoutProblems as never);
    const repeats = await run<string[]>(repeatedNumbers as never);
    const images = await run<string[]>(brokenImages as never);
    const text = (await win.webContents.executeJavaScript(
      "document.body.innerText"
    )) as string;
    // The opening text after each break the author forced (a new section on a
    // new page), so the page before it is not judged half empty.
    // Under relief, the model's own breaks between ordinary sections go (round 5).
    const forcedStarts = await run<
      Array<{ text: string; kind: "cover" | "key" | "section" }>
    >(forcedStartsIn as never, o.relief >= 1);
    // Each chart's printed pieces, to find a page that holds only a chart.
    const figureTexts = (await win.webContents.executeJavaScript(
      "[...document.querySelectorAll('figure.chart:not(.as-numbers)')].map((f) => [...f.querySelectorAll('svg text, figcaption')].map((t) => (t.textContent || '').trim()).filter(Boolean))"
    )) as string[][];
    // Word's charts and pictures: shot from this page as it printed.
    if (blocks?.some((b) => b.t === "picture"))
      blocks = await shootPictures(win, blocks);
    const html = (await win.webContents.executeJavaScript(
      "'<!doctype html>\\n' + document.documentElement.outerHTML"
    )) as string;
    const [bleed, landscape] = (await win.webContents.executeJavaScript(
      "[document.body.classList.contains('bleed'), document.body.classList.contains('landscape')]"
    )) as [boolean, boolean];
    await fs.writeFile(printPath, html);
    return {
      sums,
      charts,
      fitted,
      text,
      blocks,
      bleed,
      landscape,
      dropped,
      forcedStarts,
      figureTexts,
      layout,
      repeats,
      images,
      sparse,
    };
  } finally {
    clearTimeout(timeout);
    if (!win.isDestroyed()) win.destroy();
  }
};

export const makeDocument = async (opts: {
  htmlPath: string;
  outBase: string;
  kind: "doc" | "deck";
  ask: Ask;
  brief: string;
  /** A look chosen in the app ("try another look"): wins over any the request names. */
  look?: string;
  /** A design chosen in the app: wins over any the request names. */
  design?: string;
  /**
   * What the numbers must come from: the user's words, their files and what
   * the bot read; the brief when not given (request-facts.ts).
   */
  facts?: string;
  /** The user's own words, for the chart rule (the brief when not given). */
  request?: string;
  today: string;
  /** The last attempt: leave out blocks holding numbers nobody gave. */
  dropUnsupported?: boolean;
}): Promise<MakeResult> => {
  const dir = path.dirname(opts.htmlPath);
  await placeSystem(dir);
  const printPath = path.join(dir, `${path.basename(opts.outBase)}.print.html`);
  const wantDocx = opts.ask.formats.includes("docx");
  const wantPdf =
    opts.ask.formats.includes("pdf") ||
    opts.ask.formats.includes("pptx") ||
    opts.kind === "deck";
  const pdfPath = `${opts.outBase}.pdf`;

  let fit = 1;
  let relief = 0;
  let prints = 0;
  const briefNumbers = briefValues(opts.brief);
  const checkFacts = opts.ask.genre !== "teaching";
  let drop: string[] = [];
  const source = await fs.readFile(opts.htmlPath, "utf8").catch(() => "");
  const pageType = docTypeOf(source);
  // A certificate or invitation always prints in a design: the plain layout
  // looked unfinished beside main's (comparison, 17 Nov).
  const fallbackDesign =
    opts.kind === "deck" || /<html\b[^>]*\bdata-design=/i.test(source)
      ? null
      : pageType === "certificate"
        ? "certificate-heritage"
        : pageType === "invitation"
          ? /\b(wedding|marriage|anniversary|christening|engagement|shaadi|vivah)\b/i.test(
              source
            )
            ? "invitation-vows"
            : /\b(turns?|turning)\s+\d|\b(kids?|child|children|daughter|son|bachcha|beti|beta)\b/i.test(
                  source
                )
              ? "invitation-confetti"
              : "invitation-soiree"
          : null;
  const cvName = /class="[^"]*\bcv-head\b[^"]*"[^>]*>\s*<h1[^>]*>([^<]+)<\/h1>/i
    .exec(source)?.[1]
    ?.trim();
  const sampleName =
    pageType === "resume" &&
    cvName != null &&
    !/^\[?\s*your (full )?name\s*\]?$/i.test(cvName) &&
    opts.facts != null &&
    opts.facts !== opts.brief &&
    !opts.facts.toLowerCase().includes(cvName.toLowerCase());
  // A page headed "Your Name" is a sample résumé, whatever markup it used
  // (live m02: a doc-head, not a cv-head).
  const firstH1 = /<h1[^>]*>([^<]+)<\/h1>/i.exec(source)?.[1]?.trim();
  const sampleCv =
    (pageType === "resume" && sampleName) ||
    [cvName, firstH1].some(
      (h) => h != null && /^\[?\s*your (full )?name\s*\]?$/i.test(h)
    );
  const isCv = pageType === "resume" || sampleCv;
  const again = (): Promise<Prepared> =>
    prepare(opts.htmlPath, printPath, opts.kind, opts.ask, {
      fit,
      wantBlocks: wantDocx,
      briefNumbers,
      drop,
      dropFailedCharts: opts.dropUnsupported === true,
      relief,
      look: opts.look ?? namedLook(opts.request ?? opts.brief),
      design:
        opts.design ??
        namedDesign(opts.request ?? opts.brief, pageType) ??
        fallbackDesign,
      sampleName,
      sampleCv,
      inlineBlanks: ["letter", "flyer", "proposal", "report"].includes(
        pageType
      ),
    });
  let prepared = await again();
  // The last attempt leaves out what still holds a number nobody gave.
  if (opts.dropUnsupported === true && checkFacts) {
    drop = unsupportedNumbers(prepared.text, {
      brief: opts.facts ?? opts.brief,
      computed: [...prepared.sums.computed, ...prepared.charts.computed],
      today: opts.today,
    });
    if (drop.length > 0) prepared = await again();
  }
  let pptxPath: string | null = null;
  let pages: string[] = [];
  let issues: PageIssue[] = [];

  if (wantPdf) {
    let heights: number[] = [];
    const printOnce = async (): Promise<void> => {
      prints++;
      if (opts.kind === "deck") {
        const r = await exportDeckPdf({
          htmlPath: printPath,
          outputPath: pdfPath,
        });
        pptxPath = r.pptxPath;
      } else {
        await exportDocumentPdf({
          htmlPath: printPath,
          outputPath: pdfPath,
          ...pageFor({
            bleed: prepared.bleed,
            landscape: prepared.landscape,
          }).print,
        });
      }
      pages = await pdfPageTexts(pdfPath);
      issues =
        opts.kind === "doc" && !prepared.bleed
          ? judgePages(pages, {
              // A résumé is one page unless more were asked for.
              onePage:
                opts.ask.onePage ||
                (isCv && !/\b(two|2)[- ]pages?\b/i.test(opts.brief)),
              usedHeight: (heights = await pdfUsedHeights(pdfPath)),
              forcedStarts: prepared.forcedStarts,
              figureTexts: prepared.figureTexts,
            })
          : [];
    };
    let best: { count: number; fit: number; relief: number } | null = null;
    for (;;) {
      await printOnce();
      if (best == null || issues.length < best.count)
        best = { count: issues.length, fit, relief };
      if (issues.length === 0 || prints >= 6) break;
      // A page left under 40% full: first let big blocks break across pages,
      // then shorten the charts; only then shrink the type.
      // A short spill onto a second page (two rows of a table, a sign-off)
      // shrinks back onto the first before blocks are let break: breaking
      // them is what spilled the minutes' action table (master's read, u08).
      const spill = pages.length === 2 && (heights[1] ?? 1) < 0.3 && fit > 0.88;
      if (
        !spill &&
        issues.some(
          (i) => i.kind === "underfilled" || i.kind === "chart-alone"
        ) &&
        relief < 2 &&
        // A résumé has no big blocks to break: it shrinks to its one page.
        !isCv
      ) {
        relief++;
      } else if (fit > (isCv ? 0.74 : 0.88)) {
        // Down to 0.88: below that the 9 pt labels would print under 8 pt; a
        // résumé to 0.74, as its smallest type is larger.
        fit = Math.round((fit - (isCv ? 0.06 : 0.04)) * 100) / 100;
      } else break;
      prepared = await again();
    }
    // A later attempt can come out worse; print the best one again.
    if (best != null && issues.length > best.count) {
      fit = best.fit;
      relief = best.relief;
      prepared = await again();
      await printOnce();
    }
  }

  let docxPath: string | null = null;
  if (wantDocx && prepared.blocks) {
    docxPath = `${opts.outBase}.docx`;
    await fs.writeFile(docxPath, await buildDocx(prepared.blocks));
  }

  // Every font in the PDF must be one the app ships.
  const otherFonts = wantPdf
    ? foreignFonts(fontsInPdf(await fs.readFile(pdfPath)))
    : [];
  const readback = wantPdf
    ? readBack(prepared.text, pages)
    : {
        ok: true,
        wordsFound: 0,
        wordsTotal: 0,
        missingNumbers: [],
        emptyPages: [],
      };
  const unsupported = checkFacts
    ? unsupportedNumbers(prepared.text, {
        brief: opts.facts ?? opts.brief,
        computed: [...prepared.sums.computed, ...prepared.charts.computed],
        today: opts.today,
      })
    : [];
  // A report or deck with a series of figures and no chart (round 2: a pitch's
  // traction and revenue, tiles only).
  const wantsChart = missingChart({
    genre: opts.ask.genre,
    drawn: prepared.charts.drawn,
    asNumbers: prepared.charts.asNumbers,
    // Each figure once, no years (overnight: a roadmap was asked for a
    // chart), from the request itself: the facts carry tool output too, and
    // a file listing's sizes asked a five-slide talk for a chart.
    briefNumbers: briefFigures(opts.request ?? opts.brief),
  });
  const sendBack = [
    ...prepared.images.map(
      (i) =>
        `${i} Use the path you opened the picture with (from your folder, or absolute); the app copies it beside the page.`
    ),
    ...prepared.layout.map(
      (l) =>
        `${l} Nothing may be drawn over anything else: shorten it or use a layout with room for it.`
    ),
    ...(prepared.repeats.length > 0
      ? [`${prepared.repeats.join(" ")} Show each number once on a slide.`]
      : []),
    ...prepared.sums.problems,
    ...prepared.sparse,
    // The slide count is an ask like a marks total ("8 slides", or a "Slide N:" outline).
    ...(opts.kind === "deck" &&
    opts.ask.slides != null &&
    pages.length > 0 &&
    pages.length !== opts.ask.slides
      ? [
          `The deck has ${pages.length} slides; the brief asks for ${opts.ask.slides}. Make it ${opts.ask.slides}.`,
        ]
      : []),
    ...(unsupported.length > 0
      ? [
          `These numbers are not in the request and were not computed by the app: ${unsupported.slice(0, 10).join(", ")}. A number you work out (a share, a change, a total, a per-month figure) must be written as <span data-calc="…"> so the app computes it; anything else you made up (reference numbers, dates, figures) must go.`,
        ]
      : []),
    ...(wantsChart
      ? [
          "There is no chart, but the brief gives figures that compare or grow. Show the main series in a figure.chart (bar, growth or share), on its own slide or beside the text.",
        ]
      : []),
    ...prepared.charts.failed.map((f) => `A chart could not be drawn: ${f}.`),
    ...(() => {
      const notGiven = sharesNotGiven(
        prepared.charts.shares,
        opts.facts ?? opts.brief
      );
      return notGiven.length > 0
        ? [
            `A share chart shows ${notGiven.join(", ")} as a percentage, but the request does not give ${notGiven.length === 1 ? "it" : "them"} as one. Show counts as tiles or a bar chart, not a share.`,
          ]
        : [];
    })(),
    ...prepared.fitted.shrunk
      .filter((s) => !s.fits)
      .map(
        (s) =>
          `${s.box} has more than fits, even at the smallest type; cut it down or split it.`
      ),
    ...(issues.length > 0
      ? [
          `${describeIssues(issues).join(" ")} Shorten or restructure so the pages are full (or one page, if one was asked).`,
        ]
      : []),
    ...(!readback.ok
      ? [
          `The printed file is missing text: ${readback.emptyPages.length ? `pages ${readback.emptyPages.join(", ")} are empty; ` : ""}${readback.missingNumbers.length ? `numbers ${readback.missingNumbers.slice(0, 8).join(", ")} did not print; ` : ""}${readback.wordsFound} of ${readback.wordsTotal} words printed.`,
        ]
      : []),
  ];

  // The last print may not hand over a page with text drawn over text, or a
  // broken image the bot would call embedded.
  const failed =
    opts.dropUnsupported === true
      ? [...prepared.images, ...prepared.layout]
      : [];
  if (failed.length > 0) {
    for (const f of [wantPdf ? pdfPath : null, pptxPath, docxPath])
      if (f != null) await fs.rm(f, { force: true });
  }
  return {
    pdfPath: wantPdf && failed.length === 0 ? pdfPath : null,
    pptxPath: failed.length === 0 ? pptxPath : null,
    docxPath: failed.length === 0 ? docxPath : null,
    pages: pages.length,
    sums: prepared.sums,
    foreignFonts: otherFonts,
    dropped: prepared.dropped,
    sendBack,
    layout: prepared.layout,
    images: prepared.images,
    failed,
  };
};
