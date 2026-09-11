#!/usr/bin/env node

/**
 * i18n bare-literal guard (regression ratchet).
 *
 * Scans the renderer source tree (src/renderer/) for user-facing English
 * string literals that should go through react-i18next
 * (`t('...')` / `i18n.t('...')`). Rule: all user-facing UI strings must be
 * localized — never hard-code English text in components.
 *
 * It is a RATCHET, not a full audit: a committed baseline
 * (scripts/i18n-literals-baseline.json) records the literals that already
 * existed when the guard was introduced, so CI fails only when a NEW bare
 * literal is added — existing debt is grandfathered, regressions are blocked.
 *
 * Detected patterns (high-signal, low false-positive):
 *   A) toast.<level>('literal')                — bare string passed to a Sonner toast
 *   B) user-facing JSX attrs with a literal     — placeholder / title / aria-label /
 *      alt / label / message / tooltip = "Text" or ={'Text'}
 *   C) multi-word JSX text nodes                — >Some Capitalized Text< on one line
 *
 * It intentionally does NOT try to catch every literal (e.g. multi-line JSX
 * text). It catches the common regression vectors. Lines with an
 * `i18n-ignore` comment are skipped.
 *
 * Usage:
 *   node scripts/check-jsx-i18n.js            # check; exit 1 on new violations
 *   node scripts/check-jsx-i18n.js --update   # regenerate the baseline
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const SCAN_DIRS = ["src/renderer"];
const BASELINE_PATH = path.join(
  import.meta.dirname,
  "i18n-literals-baseline.json"
);

const UI_ATTRS = [
  "placeholder",
  "title",
  "aria-label",
  "alt",
  "label",
  "message",
  "tooltip",
];

/** Recursively collect *.tsx files under a directory. */
function collectTsx(dir) {
  const abs = path.join(ROOT, dir);
  const out = [];
  if (!fs.existsSync(abs)) return out;
  for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
    const rel = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...collectTsx(rel));
    else if (
      entry.isFile() &&
      entry.name.endsWith(".tsx") &&
      !entry.name.endsWith(".test.tsx")
    )
      out.push(rel);
  }
  return out;
}

/** Detect bare user-facing literals on a single line. Returns [{kind, text}]. */
function detectLine(line) {
  const found = [];
  if (/\bi18n-ignore\b/.test(line)) return found;

  // A) toast.<level>('literal' | "literal" | `literal`) — bare string as first arg.
  const toastRe =
    /\btoast\.(?:error|success|warning|info|loading|message)\(\s*(['"`])((?:\\.|(?!\1).)*?)\1/g;
  let m;
  while ((m = toastRe.exec(line)) !== null) {
    if (/[A-Za-z]/.test(m[2])) found.push({ kind: "toast", text: m[2].trim() });
  }

  // B) user-facing JSX attribute with a literal value.
  const attrAlt = UI_ATTRS.join("|");
  // B1: attr="Text"
  const attrDq = new RegExp(
    `\\b(?:${attrAlt})="([^"{}]*[A-Za-z][^"{}]*)"`,
    "g"
  );
  while ((m = attrDq.exec(line)) !== null)
    found.push({ kind: "attr", text: m[1].trim() });
  // B2: attr={'Text'} or attr={"Text"}
  const attrBrace = new RegExp(
    `\\b(?:${attrAlt})=\\{\\s*(['"])((?:\\\\.|(?!\\1).)*?)\\1\\s*\\}`,
    "g"
  );
  while ((m = attrBrace.exec(line)) !== null) {
    if (/[A-Za-z]/.test(m[2])) found.push({ kind: "attr", text: m[2].trim() });
  }

  // C) multi-word JSX text node on a single line: >Capitalized Words<
  //    Requires a leading capital letter and at least one space, and forbids
  //    braces (so interpolations like >Hi {name}< are ignored).
  const textRe =
    />\s*([A-Z][A-Za-z]+(?:[ '&/,.!?:()-]+[A-Za-z0-9]+)+[.!?]?)\s*</g;
  while ((m = textRe.exec(line)) !== null) {
    const text = m[1].trim();
    // Ignore things that are clearly not prose (e.g. ALLCAPS tokens only).
    if (/[a-z]/.test(text)) found.push({ kind: "text", text });
  }

  return found;
}

function scan() {
  const files = SCAN_DIRS.flatMap(collectTsx).sort();
  const violations = []; // {file, line, kind, text, sig}
  for (const file of files) {
    const content = fs.readFileSync(path.join(ROOT, file), "utf8");
    const lines = content.split("\n");
    lines.forEach((line, i) => {
      for (const hit of detectLine(line)) {
        violations.push({
          file,
          line: i + 1,
          kind: hit.kind,
          text: hit.text,
          sig: `${file}|${hit.kind}|${hit.text}`,
        });
      }
    });
  }
  return violations;
}

function loadBaseline() {
  if (!fs.existsSync(BASELINE_PATH)) return { signatures: [] };
  return JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8"));
}

function main() {
  const update = process.argv.includes("--update");
  const violations = scan();
  const uniqueSigs = [...new Set(violations.map((v) => v.sig))].sort();

  if (update) {
    const baseline = {
      _comment:
        "Grandfathered i18n bare-literal signatures (file|kind|text). Regenerate with `node scripts/check-jsx-i18n.js --update`. Do NOT add new entries by hand — localize the string instead.",
      signatures: uniqueSigs,
    };
    fs.writeFileSync(BASELINE_PATH, JSON.stringify(baseline, null, 2) + "\n");
    console.log(
      `[i18n-guard] Baseline updated: ${uniqueSigs.length} grandfathered literals across ${SCAN_DIRS.length} dirs.`
    );
    return;
  }

  const baseline = new Set(loadBaseline().signatures);
  const fresh = violations.filter((v) => !baseline.has(v.sig));

  if (fresh.length === 0) {
    console.log(
      `[i18n-guard] OK — no new bare UI literals (${baseline.size} grandfathered).`
    );
    return;
  }

  console.error(
    `\n[i18n-guard] FAIL — ${fresh.length} new bare user-facing literal(s) found.`
  );
  console.error(
    "Wrap these in t(...) / i18n.t(...) and add a key to src/renderer/locales/en-US.json."
  );
  console.error(
    "(If this is genuinely not user-facing, add an `i18n-ignore` comment on the line, or run `node scripts/check-jsx-i18n.js --update` if you have a deliberate reason.)\n"
  );
  for (const v of fresh) {
    console.error(
      `  ${v.file}:${v.line}  [${v.kind}]  ${JSON.stringify(v.text)}`
    );
  }
  console.error("");
  process.exit(1);
}

main();
