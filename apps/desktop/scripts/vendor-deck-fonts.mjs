#!/usr/bin/env node
/**
 * Puts each listed deck template's Google Fonts beside it, so a deck prints
 * with its own faces offline: a fonts.css and its .woff2 files, flat in the
 * template's folder (renderDeck copies a template's files, not folders).
 *
 * - Latin and Latin Extended subsets of every face the template asks for.
 * - Devanagari: every family the template declares also gets Noto Sans
 *   Devanagari for U+0900-097F and friends, so Hindi text is drawn with a
 *   bundled face whatever the template's font.
 * - CJK families (Noto Sans/Serif SC) are left out: each weight is several
 *   megabytes; Chromium falls back to the system's CJK font.
 *
 * Run from apps/desktop: node scripts/vendor-deck-fonts.mjs
 * Needs network; run again after adding a template. All faces are OFL.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

const decks = path.resolve(import.meta.dirname, "../resources/decks");
const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const KEEP = new Set(["latin", "latin-ext"]);
const CJK = /^Noto\+(Sans|Serif)\+(SC|TC|JP|KR)/;

const get = async (url, as = "text") => {
  const response = await fetch(url, { headers: { "User-Agent": UA } });
  if (!response.ok) throw new Error(`${response.status} ${url}`);
  return as === "text"
    ? response.text()
    : Buffer.from(await response.arrayBuffer());
};

/** The @font-face blocks of a css2 response, each with its subset name. */
const faces = (css) =>
  [...css.matchAll(/\/\*\s*([\w-]+)\s*\*\/\s*(@font-face\s*{[^}]*})/g)].map(
    (m) => ({
      subset: m[1],
      block: m[2],
    })
  );

const field = (block, name) =>
  new RegExp(`${name}:\\s*([^;]+);`).exec(block)?.[1]?.trim() ?? "";

const DEVANAGARI_URL =
  "https://fonts.googleapis.com/css2?family=Noto+Sans+Devanagari:wght@400;700&display=swap";

const main = async () => {
  const index = JSON.parse(
    readFileSync(path.join(decks, "templates.json"), "utf8")
  );
  const devanagari = faces(await get(DEVANAGARI_URL)).filter(
    (face) => face.subset === "devanagari"
  );
  const notes = [];
  // A template already vendored has no link left to read its families from:
  // its line in FONTS.md is kept as it was.
  const kept = new Map(
    (() => {
      try {
        return readFileSync(path.join(decks, "FONTS.md"), "utf8").split("\n");
      } catch {
        return [];
      }
    })()
      .map((line) => /^- ([\w-]+): (.+)$/.exec(line))
      .filter((match) => match != null)
      .map((match) => [match[1], `${match[1]}: ${match[2]}`])
  );

  for (const { slug } of index.templates) {
    const dir = path.join(decks, "templates", slug);
    const file = path.join(dir, "template.html");
    let html = readFileSync(file, "utf8");
    const urls = [
      ...html.matchAll(/https:\/\/fonts\.googleapis\.com\/css2\?[^"')\s]+/g),
    ].map((m) => m[0].replace(/&amp;/g, "&"));

    if (urls.length === 0) {
      console.log(`${slug}: no Google Fonts link, left alone`);
      if (kept.has(slug)) notes.push(kept.get(slug));
      continue;
    }

    const blocks = [];
    const families = new Set();
    const written = new Map();
    const save = async (src, name) => {
      if (written.has(src)) return written.get(src);
      const bytes = await get(src, "bytes");
      const out = `font-${name}-${createHash("sha1").update(src).digest("hex").slice(0, 8)}.woff2`;
      // One shared folder (decks/fonts): the deck builder copies the files a
      // template's fonts.css names next to each deck.
      writeFileSync(path.join(decks, "fonts", out), bytes);
      written.set(src, out);
      return out;
    };

    for (const url of urls) {
      const u = new URL(url);
      const kept = u.searchParams
        .getAll("family")
        .filter((f) => !CJK.test(f.replace(/ /g, "+")));
      if (kept.length === 0) continue;
      const query = kept
        .map(
          (f) =>
            `family=${encodeURIComponent(f).replace(/%20/g, "+").replace(/%3A/gi, ":").replace(/%40/g, "@").replace(/%3B/gi, ";").replace(/%2C/gi, ",")}`
        )
        .join("&");
      const css = await get(
        `https://fonts.googleapis.com/css2?${query}&display=swap`
      );
      for (const face of faces(css)) {
        if (!KEEP.has(face.subset)) continue;
        const family = field(face.block, "font-family").replace(/['"]/g, "");
        families.add(family);
        const src = /url\(([^)]+)\)/.exec(face.block)[1];
        const name =
          `${family}-${field(face.block, "font-weight")}-${field(face.block, "font-style")}-${face.subset}`
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-");
        const local = await save(src, name);
        blocks.push(
          face.block
            .replace(/url\([^)]+\)/, `url("${local}")`)
            .replace(/font-family:\s*'([^']+)'/, 'font-family: "$1"')
        );
      }
    }

    // Devanagari once per weight (or variable range) the Latin faces have, never as a wider
    // range: a range matched a weight with no exact Latin face (650, 800, 300)
    // to the Devanagari face, which has no Latin letters, and headings fell
    // back to Liberation or DejaVu (quality study, round 1).
    const latinWeights = new Map();
    for (const b of blocks) {
      const f = field(b, "font-family").replace(/['"]/g, "");
      if (!latinWeights.has(f)) latinWeights.set(f, new Set());
      latinWeights.get(f).add(field(b, "font-weight"));
    }
    for (const family of families) {
      for (const weight of latinWeights.get(family) ?? []) {
        const face =
          devanagari.find(
            (d) =>
              field(d.block, "font-weight") ===
              (Number(weight.split(" ")[0]) >= 600 ? "700" : "400")
          ) ?? devanagari[0];
        if (!face) continue;
        const src = /url\(([^)]+)\)/.exec(face.block)[1];
        const local = await save(
          src,
          `noto-sans-devanagari-${field(face.block, "font-weight")}`
        );
        blocks.push(
          `@font-face {\n  font-family: "${family}";\n  font-style: normal;\n  font-weight: ${weight};\n  font-display: swap;\n  src: url("${local}") format("woff2");\n  unicode-range: ${field(face.block, "unicode-range")};\n}`
        );
      }
    }

    writeFileSync(
      path.join(dir, "fonts.css"),
      `/* Generated by scripts/vendor-deck-fonts.mjs from Google Fonts (SIL Open Font License). */\n${blocks.join("\n")}\n`
    );

    // The template's own links go; one local stylesheet takes their place.
    html = html
      .replace(/[ \t]*<link[^>]*fonts\.(googleapis|gstatic)\.com[^>]*>\n?/g, "")
      .replace(
        /[ \t]*@import url\(['"]?https:\/\/fonts\.googleapis\.com[^)]*\);?\n?/g,
        ""
      );
    if (!html.includes('href="fonts.css"'))
      html = html.replace(
        /<\/title>/i,
        '</title>\n  <link rel="stylesheet" href="fonts.css">'
      );
    writeFileSync(file, html);
    notes.push(`${slug}: ${[...families].join(", ")}`);
    console.log(`${slug}: ${families.size} families, ${written.size} files`);
  }

  writeFileSync(
    path.join(decks, "FONTS.md"),
    `# Deck template fonts\n\nDownloaded from Google Fonts by \`apps/desktop/scripts/vendor-deck-fonts.mjs\`. All are under the SIL Open Font License 1.1 (https://openfontlicense.org). Latin and Latin Extended subsets, plus Noto Sans Devanagari for Devanagari text in every family. CJK text falls back to the system's CJK font.\n\n${notes.map((n) => `- ${n}`).join("\n")}\n- Noto Sans Devanagari (Devanagari range, in every template)\n`
  );
};

await main();
