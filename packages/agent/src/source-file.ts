/**
 * The user's own deck or document, read in code: every slide's or paragraph's
 * words, chart data and pictures, so "improve my deck" needs no model turns
 * unzipping and rendering the file (deck-speed.md: 1-4 minutes of them).
 */
import fs from "node:fs/promises";
import path from "node:path";

import JSZip from "jszip";

import { resolveInWorkspace } from "./workspace-path.js";

export type SourceFile = { text: string; pictures: string[] };

const decode = (s: string): string =>
  s
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** Paragraphs of a DrawingML or WordprocessingML part, one per line. */
const paragraphs = (xml: string, p: string, t: string): string[] =>
  [...xml.matchAll(new RegExp(`<${p}\\b[\\s\\S]*?</${p}>`, "g"))]
    .map((m) =>
      [...m[0].matchAll(new RegExp(`<${t}(?:\\s[^>]*)?>([^<]*)</${t}>`, "g"))]
        .map((x) => decode(x[1] ?? ""))
        .join("")
        .trim()
    )
    .filter((line) => line.length > 0);

const relsOf = async (
  zip: JSZip,
  part: string
): Promise<Array<{ type: string; target: string }>> => {
  const rels = `${path.posix.dirname(part)}/_rels/${path.posix.basename(part)}.rels`;
  const xml = (await zip.file(rels)?.async("string")) ?? "";
  return [...xml.matchAll(/<Relationship\b[^>]*>/g)].map((m) => ({
    type: /Type="[^"]*\/(\w+)"/.exec(m[0])?.[1] ?? "",
    target: path.posix.normalize(
      path.posix.join(
        path.posix.dirname(part),
        /Target="([^"]*)"/.exec(m[0])?.[1] ?? ""
      )
    ),
  }));
};

/** A chart's series as "name: category value, …". */
const chartText = (xml: string): string[] =>
  [...xml.matchAll(/<c:ser>[\s\S]*?<\/c:ser>/g)].map((m) => {
    const ser = m[0];
    const values = (tag: string): string[] =>
      [
        ...(
          new RegExp(`<c:${tag}>[\\s\\S]*?</c:${tag}>`).exec(ser)?.[0] ?? ""
        ).matchAll(/<c:v>([^<]*)<\/c:v>/g),
      ].map((x) => decode(x[1] ?? ""));
    const name = values("tx")[0] ?? "Series";
    const cats = values("cat");
    const vals = values("val");
    return `${name}: ${vals.map((v, i) => `${cats[i] ?? i + 1} ${v}`).join(", ")}`;
  });

const savePicture = async (
  zip: JSZip,
  part: string,
  outDir: string,
  prefix: string
): Promise<string | null> => {
  const file = zip.file(part);
  if (file == null || !/\.(png|jpe?g|gif|webp|svg)$/i.test(part)) return null;
  await fs.mkdir(outDir, { recursive: true });
  const out = path.join(outDir, `${prefix}-${path.posix.basename(part)}`);
  await fs.writeFile(out, await file.async("nodebuffer"));
  return out;
};

export const readSourceFile = async (
  file: string,
  outDir: string
): Promise<SourceFile> => {
  const zip = await JSZip.loadAsync(await fs.readFile(file));
  const lines: string[] = [];
  const pictures: string[] = [];
  if (/\.pptx$/i.test(file)) {
    const slides = Object.keys(zip.files)
      .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
      .sort((a, b) => Number(/\d+/.exec(a)![0]) - Number(/\d+/.exec(b)![0]));
    for (const [i, part] of slides.entries()) {
      const xml = (await zip.file(part)?.async("string")) ?? "";
      lines.push(`Slide ${i + 1}:`);
      for (const line of paragraphs(xml, "a:p", "a:t")) lines.push(`  ${line}`);
      for (const rel of await relsOf(zip, part)) {
        if (rel.type === "chart") {
          const chart = (await zip.file(rel.target)?.async("string")) ?? "";
          for (const s of chartText(chart)) lines.push(`  Chart data: ${s}`);
        } else if (rel.type === "image") {
          const saved = await savePicture(
            zip,
            rel.target,
            outDir,
            `slide${i + 1}`
          );
          if (saved != null) {
            pictures.push(saved);
            lines.push(`  Picture: ${saved}`);
          }
        }
      }
    }
  } else if (/\.docx$/i.test(file)) {
    const part = "word/document.xml";
    const xml = (await zip.file(part)?.async("string")) ?? "";
    lines.push(...paragraphs(xml, "w:p", "w:t"));
    for (const rel of await relsOf(zip, part))
      if (rel.type === "image") {
        const saved = await savePicture(zip, rel.target, outDir, "doc");
        if (saved != null) {
          pictures.push(saved);
          lines.push(`Picture: ${saved}`);
        }
      }
  } else throw new Error("Only a .pptx or .docx can be read this way.");
  return { text: lines.join("\n"), pictures };
};

/** Heads the user's own file's text in a brief; request-facts.ts finds it there. */
export const SOURCE_FILE_HEAD =
  "The user's own file, read by the app (keep all of its content, and use its pictures by these paths):";

/**
 * The user's own .pptx or .docx, read in code and added to the brief: the
 * bot no longer spends minutes of turns unzipping it (deck-speed.md).
 */
export const withSourceFile = async (
  brief: string,
  sourceFile: unknown,
  outputPath: string,
  cwd: string
): Promise<string> => {
  if (
    typeof sourceFile !== "string" ||
    !/\.(pptx|docx)$/i.test(sourceFile.trim())
  )
    return brief;
  const file = resolveInWorkspace(sourceFile.trim(), cwd);
  const base = path.basename(outputPath).replace(/\.[^.]+$/, "");
  const read = await readSourceFile(
    file,
    path.join(path.dirname(outputPath), `${base}-from-file`)
  );
  return `${brief}\n\n${SOURCE_FILE_HEAD}\n${read.text}`;
};
