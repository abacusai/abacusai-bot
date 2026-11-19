/**
 * "Try another look" under a finished document: the same page printed again
 * in another of the design system's looks, from the source the document tool
 * kept beside it. No model call: the look is CSS (system.css, data-look).
 */
import fs from "fs/promises";
import path from "path";

import { readAsk } from "./ask";
import { designsOf, docTypeOf } from "./designs";
import { DOC_LOOKS, makeDocument } from "./make";

const exists = (file: string): Promise<boolean> =>
  fs.stat(file).then(
    () => true,
    () => false
  );

const sourceOf = (filePath: string): string => {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.(pdf|docx)$/i, "");
  return path.join(dir, `${base}-source`, `${base}.html`);
};

/** A finished document's type and the designs it can switch to. */
export const designsFor = async (
  filePath: string
): Promise<{ type: string; designs: Array<{ id: string; name: string }> }> => {
  const html = await fs.readFile(sourceOf(filePath), "utf8").catch(() => "");
  if (html === "" || /<body[^>]*class="[^"]*\bdeck\b/.test(html))
    return { type: "", designs: [] };
  const type = docTypeOf(html);
  return {
    type,
    designs: designsOf(type).map(({ id, name }) => ({ id, name })),
  };
};

export const relookDocument = async (
  filePath: string,
  look: string | undefined,
  design?: string
): Promise<{ path: string }> => {
  if (look != null && !(DOC_LOOKS as readonly string[]).includes(look))
    throw new Error(`Unknown look: ${look}`);
  const dir = path.dirname(filePath);
  const base = path.basename(filePath).replace(/\.(pdf|docx)$/i, "");
  const source = sourceOf(filePath);
  const deckHint =
    "This is a deck: use Try another look on its PowerPoint row to pick another template.";
  if (!(await exists(source))) {
    if (await exists(path.join(dir, `${base}-deck`))) throw new Error(deckHint);
    throw new Error("This file has no design source beside it to print again.");
  }
  const html = await fs.readFile(source, "utf8");
  if (/<body[^>]*class="[^"]*\bdeck\b/.test(html)) throw new Error(deckHint);
  const brief = await fs
    .readFile(source.replace(/\.html$/, ".brief.txt"), "utf8")
    .catch(() => "");
  const facts = await fs
    .readFile(source.replace(/\.html$/, ".facts.txt"), "utf8")
    .catch(() => null);
  const ask = readAsk(brief);
  const outBase = path.join(dir, base);
  // The formats it was made in: a Word file stays a Word file.
  ask.formats = [
    ...((await exists(`${outBase}.docx`)) ? ["docx" as const] : []),
    ...((await exists(`${outBase}.pdf`)) || !(await exists(`${outBase}.docx`))
      ? ["pdf" as const]
      : []),
  ];
  // The look is kept in the source too, so a later change keeps it.
  if (design != null && design !== "classic") {
    const type = docTypeOf(html);
    if (!designsOf(type).some((d) => d.id === design))
      throw new Error(`No ${type} design called ${design}.`);
  }
  // The look and design are kept in the source too, so a later change keeps them.
  const set = (
    attrs: string,
    name: string,
    value: string | undefined
  ): string => {
    if (value == null) return attrs;
    const rest = attrs.replace(new RegExp(`\\s+${name}="[^"]*"`, "i"), "");
    // A classic design is written down: a certificate or invitation with no
    // design at all gets one picked for it (make.ts).
    return value === "classic" && name === "data-look"
      ? rest
      : `${rest} ${name}="${value}"`;
  };
  await fs.writeFile(
    source,
    html.replace(/<html\b([^>]*)>/i, (_whole, attrs: string) => {
      return `<html${set(set(attrs, "data-look", look), "data-design", design)}>`;
    })
  );
  const made = await makeDocument({
    htmlPath: source,
    outBase,
    kind: "doc",
    ask,
    brief,
    ...(look != null ? { look } : {}),
    ...(design != null ? { design } : {}),
    ...(facts != null ? { facts } : {}),
    today: new Date().toLocaleDateString("en-GB", {
      weekday: "long",
      day: "numeric",
      month: "long",
      year: "numeric",
    }),
    dropUnsupported: true,
  });
  const out = made.pdfPath ?? made.docxPath;
  if (out == null) throw new Error("The page could not be printed again.");
  return { path: filePath };
};
