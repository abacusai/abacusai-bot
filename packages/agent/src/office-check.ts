/**
 * Opens an office file the way a viewer would before it is handed over, and
 * lists what would greet the user: a workbook Excel repairs, formulas pointing
 * at a sheet or workbook that is not there, blanks never filled, a PDF with no
 * pages. Structure only: nothing here recalculates a formula.
 */
import fs from "fs";
import path from "path";

import JSZip from "jszip";

export interface OfficeCheck {
  /** One line on what was opened, e.g. "4 sheets, 812 formulas". */
  summary: string;
  /** What the user would hit; empty when none was found. */
  problems: string[];
  /** The file cannot be opened at all. */
  broken: boolean;
}

const PLACEHOLDER_RE =
  /lorem ipsum|\bTODO\b|\bTBD\b|\bXXX+\b|\[insert[^\]]*\]|\{\{[^}]*\}\}|_{4,}|click to add (title|text)/i;

const unescapeXml = (s: string): string =>
  s
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");

const xmlText = (xml: string): string =>
  unescapeXml(xml.replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ");

const sample = (items: string[]): string =>
  items.slice(0, 3).join("; ") +
  (items.length > 3 ? `; and ${items.length - 3} more` : "");

async function checkXlsx(zip: JSZip): Promise<OfficeCheck> {
  const problems: string[] = [];
  const workbook = await zip.file("xl/workbook.xml")?.async("string");
  if (workbook == null)
    return {
      summary: "",
      problems: ["it has no workbook part, so Excel cannot open it"],
      broken: true,
    };

  const sheetNames = [
    ...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g),
  ].map((m) => unescapeXml(m[1]!).toLowerCase());
  const sheetFiles = Object.keys(zip.files).filter((n) =>
    /^xl\/worksheets\/sheet\d+\.xml$/.test(n)
  );
  const shared = await zip.file("xl/sharedStrings.xml")?.async("string");
  const strings = shared
    ? [...shared.matchAll(/<si>([\s\S]*?)<\/si>/g)].map((m) => xmlText(m[1]!))
    : [];

  let formulas = 0;
  const external: string[] = [];
  const badRef: string[] = [];
  const unknownSheet = new Set<string>();
  const errors: string[] = [];
  const placeholders: string[] = [];

  for (const file of sheetFiles) {
    const xml = (await zip.file(file)!.async("string")) ?? "";
    for (const cell of xml.matchAll(/<c\b([^>]*)>([\s\S]*?)<\/c>/g)) {
      const ref = /\br="([A-Z]+\d+)"/.exec(cell[1]!)?.[1] ?? "?";
      const body = cell[2]!;
      const f = /<f\b[^>]*>([\s\S]*?)<\/f>/.exec(body);
      if (f) {
        formulas++;
        const text = unescapeXml(f[1]!);
        if (/\[\d+\]/.test(text)) external.push(`${ref}: ${text.slice(0, 60)}`);
        if (/#REF!/.test(text)) badRef.push(ref);
        for (const m of text.matchAll(
          /(?<![#\w])(?:'((?:[^']|'')+)'|([A-Za-z_À-￿][\w.À-￿]*))!/g
        )) {
          const name = (m[1] ?? m[2] ?? "").replace(/''/g, "'").toLowerCase();
          if (name && !sheetNames.includes(name)) unknownSheet.add(name);
        }
      }
      if (/\bt="e"/.test(cell[1]!)) {
        const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
        if (v) errors.push(`${ref} ${v}`);
      }
      const isShared = /\bt="s"/.test(cell[1]!);
      const v = /<v>([^<]*)<\/v>/.exec(body)?.[1];
      const inline = /<is>([\s\S]*?)<\/is>/.exec(body)?.[1];
      const value =
        isShared && v != null
          ? strings[Number(v)]
          : inline
            ? xmlText(inline)
            : undefined;
      if (value && PLACEHOLDER_RE.test(value))
        placeholders.push(`${ref} "${value.slice(0, 40)}"`);
    }
  }

  const links = Object.keys(zip.files).filter((n) =>
    n.startsWith("xl/externalLinks/")
  );
  if (external.length > 0 || links.length > 0)
    problems.push(
      `${external.length} formula(s) point at another workbook (${sample(external)}). Excel asks to update links or shows #REF! for them: point them at sheets in this file.`
    );
  if (badRef.length > 0)
    problems.push(
      `${badRef.length} formula(s) contain #REF! (${sample(badRef)}).`
    );
  if (unknownSheet.size > 0)
    problems.push(
      `formulas use sheet(s) this workbook does not have: ${sample([...unknownSheet])}.`
    );
  if (errors.length > 0)
    problems.push(
      `${errors.length} cell(s) hold an error value (${sample(errors)}).`
    );
  if (placeholders.length > 0)
    problems.push(
      `placeholder text left in ${placeholders.length} cell(s): ${sample(placeholders)}.`
    );

  const charts = Object.keys(zip.files).filter((n) =>
    /^xl\/charts\/chart\d+\.xml$/.test(n)
  ).length;
  return {
    summary: `${sheetNames.length} sheet(s), ${formulas} formula(s)${charts > 0 ? `, ${charts} chart(s)` : ""}`,
    problems,
    broken: false,
  };
}

async function checkDocx(zip: JSZip): Promise<OfficeCheck> {
  const xml = await zip.file("word/document.xml")?.async("string");
  if (xml == null)
    return {
      summary: "",
      problems: ["it has no document part, so Word cannot open it"],
      broken: true,
    };
  const text = xmlText(xml.replace(/<\/w:p>/g, "\n"));
  const problems: string[] = [];
  const blanks = text.match(new RegExp(PLACEHOLDER_RE.source, "gi")) ?? [];
  if (blanks.length > 0)
    problems.push(
      `${blanks.length} blank(s) or placeholder(s) left unfilled: ${sample(blanks)}.`
    );
  const images = Object.keys(zip.files).filter((n) =>
    n.startsWith("word/media/")
  ).length;
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words < 5) problems.push("the document has almost no text.");
  return {
    summary: `${words} words, ${images} image(s)`,
    problems,
    broken: false,
  };
}

async function checkPptx(zip: JSZip): Promise<OfficeCheck> {
  const slides = Object.keys(zip.files).filter((n) =>
    /^ppt\/slides\/slide\d+\.xml$/.test(n)
  );
  if (slides.length === 0)
    return { summary: "", problems: ["it has no slides"], broken: true };
  const problems: string[] = [];
  const empty: string[] = [];
  const holders: string[] = [];
  for (const s of slides) {
    const text = xmlText((await zip.file(s)!.async("string")) ?? "");
    if (
      text.trim().length === 0 &&
      !Object.keys(zip.files).some((n) => n.startsWith("ppt/media/"))
    )
      empty.push(path.basename(s));
    if (PLACEHOLDER_RE.test(text)) holders.push(path.basename(s));
  }
  if (empty.length > 0) problems.push(`empty slide(s): ${sample(empty)}.`);
  if (holders.length > 0)
    problems.push(`placeholder text on ${sample(holders)}.`);
  return { summary: `${slides.length} slide(s)`, problems, broken: false };
}

function checkPdf(buffer: Buffer): OfficeCheck {
  const head = buffer.subarray(0, 1024).toString("latin1");
  const tail = buffer
    .subarray(Math.max(0, buffer.length - 2048))
    .toString("latin1");
  if (!head.includes("%PDF-") || !tail.includes("%%EOF"))
    return {
      summary: "",
      problems: [
        "it is not a complete PDF (the header or end marker is missing)",
      ],
      broken: true,
    };
  const pages = (buffer.toString("latin1").match(/\/Type\s*\/Page\b/g) ?? [])
    .length;
  return {
    summary: `${pages} page(s)`,
    problems: pages === 0 ? ["it has no pages"] : [],
    broken: pages === 0,
  };
}

function checkDelimited(text: string, ext: string): OfficeCheck {
  const lines = text.split(/\r?\n/).filter((l) => l.trim().length > 0);
  const problems: string[] = [];
  if (ext === ".jsonl") {
    const bad: string[] = [];
    lines.forEach((l, i) => {
      try {
        JSON.parse(l);
      } catch {
        bad.push(`line ${i + 1}`);
      }
    });
    if (bad.length > 0)
      problems.push(
        `${bad.length} line(s) are not valid JSON (${sample(bad)}).`
      );
    return { summary: `${lines.length} line(s)`, problems, broken: false };
  }
  const sep =
    ext === ".tsv"
      ? "\t"
      : lines[0]?.includes(";") && !lines[0]?.includes(",")
        ? ";"
        : ",";
  const width = (l: string) => l.split(sep).length;
  const head = lines[0] ? width(lines[0]) : 0;
  const ragged = lines.filter((l) => width(l) !== head).length;
  if (ragged > 0 && !text.includes('"'))
    problems.push(
      `${ragged} row(s) have a different number of columns from the header.`
    );
  return {
    summary: `${lines.length} row(s), ${head} column(s)`,
    problems,
    broken: false,
  };
}

const OFFICE_EXT = new Set([
  ".xlsx",
  ".xlsm",
  ".docx",
  ".pptx",
  ".pdf",
  ".csv",
  ".tsv",
  ".jsonl",
]);

/** null for a file this does not open (code, images, folders). */
export async function checkOfficeFile(
  file: string
): Promise<OfficeCheck | null> {
  const ext = path.extname(file).toLowerCase();
  if (!OFFICE_EXT.has(ext)) return null;
  let buffer: Buffer;
  try {
    buffer = await fs.promises.readFile(file);
  } catch {
    return null;
  }
  if (buffer.length === 0)
    return { summary: "", problems: ["the file is empty"], broken: true };
  if (ext === ".pdf") return checkPdf(buffer);
  if (ext === ".csv" || ext === ".tsv" || ext === ".jsonl")
    return checkDelimited(buffer.toString("utf8"), ext);
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(buffer);
  } catch {
    return {
      summary: "",
      problems: [
        "it is not a valid Office file (the zip container does not open)",
      ],
      broken: true,
    };
  }
  if (ext === ".docx") return checkDocx(zip);
  if (ext === ".pptx") return checkPptx(zip);
  return checkXlsx(zip);
}

/** id → text for a strings file: JSONL rows with an id, or a (nested) JSON object. */
function stringsOf(file: string): Map<string, string> | null {
  const out = new Map<string, string>();
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  const walk = (o: unknown, key: string): void => {
    if (typeof o === "string") out.set(key, o);
    else if (o != null && typeof o === "object")
      for (const [k, v] of Object.entries(o)) walk(v, key ? `${key}.${k}` : k);
  };
  if (file.toLowerCase().endsWith(".jsonl")) {
    text.split(/\r?\n/).forEach((line, i) => {
      if (!line.trim()) return;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        const id = String(row.id ?? row.key ?? `#${i}`);
        const value =
          row.text ??
          row.value ??
          Object.values(row).find((v) => typeof v === "string" && v !== id);
        out.set(id, String(value ?? ""));
      } catch {
        out.set(`#${i}`, "");
      }
    });
    return out;
  }
  try {
    walk(JSON.parse(text), "");
  } catch {
    return null;
  }
  return out;
}

/** Placeholders, tags, escapes and numbers: what a translation must carry over as is. */
const KEPT_TOKENS = /\{\{?[^}]*\}?\}|%[0-9.$]*[sdfi]|<[^>]+>|\\n|\n|\d+/g;
const toAsciiDigits = (s: string): string =>
  s.replace(/[٠-٩۰-۹]/g, (d) => String(d.charCodeAt(0) & 0xf));
const tokensThatMustSurvive = (s: string): string =>
  (toAsciiDigits(s).match(KEPT_TOKENS) ?? []).sort().join("|");
/** Words of the prose only: tags such as <color=#FFD700> are not language. */
const longWords = (s: string): string[] =>
  s
    .replace(KEPT_TOKENS, " ")
    .toLowerCase()
    .match(/\p{L}{4,}/gu) ?? [];

/**
 * A translated strings file against its source: every id there, placeholders,
 * numbers and line breaks kept, nothing left in the source language, no line
 * shifted onto another id.
 */
export function checkTranslation(source: string, target: string): string[] {
  const src = stringsOf(source);
  const out = stringsOf(target);
  if (src == null || out == null) return [];
  return compareStrings(src, out);
}

function compareStrings(
  src: Map<string, string>,
  out: Map<string, string>
): string[] {
  const missing: string[] = [];
  const kept: string[] = [];
  const same: string[] = [];
  const odd: string[] = [];
  for (const [id, s] of src) {
    const t = out.get(id);
    if (t == null) {
      missing.push(id);
      continue;
    }
    if (tokensThatMustSurvive(s) !== tokensThatMustSurvive(t)) kept.push(id);
    const words = longWords(s);
    const there = new Set(longWords(t));
    if (
      words.length >= 2 &&
      words.filter((w) => there.has(w)).length / words.length > 0.5
    )
      same.push(id);
    const ratio = t.length / Math.max(1, s.length);
    if (s.length > 12 && (ratio < 0.35 || ratio > 2.8)) odd.push(id);
  }
  const problems: string[] = [];
  if (missing.length > 0)
    problems.push(
      `${missing.length} of ${src.size} strings are missing (${sample(missing)}).`
    );
  if (kept.length > 0)
    problems.push(
      `${kept.length} strings changed a placeholder, number, tag or line break (${sample(kept)}).`
    );
  if (same.length > 0)
    problems.push(
      `${same.length} strings are still in the source language (${sample(same)}).`
    );
  if (odd.length > 0)
    problems.push(
      `${odd.length} strings are far shorter or longer than their source, often a line shifted onto the wrong id (${sample(odd)}).`
    );
  return problems;
}

const STRINGS_EXT = new Set([".json", ".jsonl"]);
/** At least this share of the source's ids must be in the file to call it its translation. */
const PAIR_MIN_SHARED = 0.6;

/**
 * The strings file a translated one came from, when the model did not say: a
 * .json/.jsonl beside it holding most of the same ids, mostly with other text.
 */
export function findTranslationSource(target: string): string | null {
  const ext = path.extname(target).toLowerCase();
  if (!STRINGS_EXT.has(ext)) return null;
  const out = stringsOf(target);
  if (out == null || out.size < 5) return null;
  let entries: string[];
  try {
    entries = fs.readdirSync(path.dirname(target));
  } catch {
    return null;
  }
  for (const name of entries) {
    const candidate = path.join(path.dirname(target), name);
    if (
      candidate === target ||
      !STRINGS_EXT.has(path.extname(name).toLowerCase())
    )
      continue;
    const src = stringsOf(candidate);
    if (src == null || src.size < 5) continue;
    const shared = [...src.keys()].filter((id) => out.has(id));
    if (shared.length < src.size * PAIR_MIN_SHARED) continue;
    const differs = shared.filter((id) => src.get(id) !== out.get(id)).length;
    if (differs >= shared.length / 2) return candidate;
  }
  return null;
}

export interface DeliverableFileCheck {
  /** Why the file must not be presented at all, or null. */
  refused: string | null;
  /** What was opened, for the result's "Checked:" lines. */
  notes: string[];
  /** What the user would hit, one line per problem, prefixed with the file name. */
  problems: string[];
}

/**
 * Everything present_deliverable checks on a file before handing it over:
 * that it opens, and for a translated strings file, how it compares with its
 * source (named by the model, or found beside it).
 */
export async function checkDeliverableFile(
  target: string,
  translatedFrom: string | null
): Promise<DeliverableFileCheck> {
  const name = path.basename(target);
  const office = await checkOfficeFile(target);
  if (office?.broken)
    return { refused: office.problems.join(" "), notes: [], problems: [] };
  const notes = office != null ? [`${name} opens: ${office.summary}.`] : [];
  const problems = (office?.problems ?? []).map((p) => `${name}: ${p}`);
  const source = translatedFrom ?? findTranslationSource(target);
  if (source != null) {
    notes.push(`${name} compared with ${path.basename(source)}.`);
    problems.push(
      ...checkTranslation(source, target).map((p) => `${name}: ${p}`)
    );
  }
  return { refused: null, notes, problems };
}

/**
 * The result's lines for the problems found. The same problems a second time
 * means a fix round did not move them: say so, rather than loop on them.
 */
export function deliverableProblemLines(
  problems: readonly string[],
  repeated: boolean
): string[] {
  if (problems.length === 0) return [];
  return [
    "",
    repeated
      ? "The same problems as the last time this was presented. Do not try the same fix again: tell the user plainly what is wrong or unfinished, with how much is done out of the total, instead of calling it done:"
      : "Problems the user would hit. Fix them and present again; if one cannot be fixed, tell the user plainly what is wrong instead of calling the file done:",
    ...problems.map((line) => `- ${line}`),
  ];
}
