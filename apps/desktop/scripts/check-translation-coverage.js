#!/usr/bin/env node
/** Key parity alone is insufficient: syncing used to copy English silently. */
import fs from "node:fs";
import path from "node:path";

const directory = path.resolve(import.meta.dirname, "../src/renderer/locales");
const read = (file) => JSON.parse(fs.readFileSync(file, "utf8"));
const flatten = (value, prefix = "") =>
  Object.fromEntries(
    Object.entries(value).flatMap(([key, entry]) =>
      typeof entry === "object" && entry !== null
        ? Object.entries(flatten(entry, `${prefix}${key}.`))
        : [[prefix + key, entry]]
    )
  );
const base = flatten(read(path.join(directory, "en-US.json")));
// Exact, reviewed values: names, technical notation, and words shared by languages.
// A changed English source value invalidates the exception automatically.
const exceptions = read(
  path.join(import.meta.dirname, "translation-literals.json")
);
const placeholders = (text) =>
  [...text.matchAll(/{{\s*([^}]+?)\s*}}/g)]
    .map((match) => match[1])
    .sort()
    .join("|");
const failures = [];
for (const file of fs
  .readdirSync(directory)
  .filter((file) => file.endsWith(".json") && file !== "en-US.json")) {
  const code = file.slice(0, -5);
  const translated = flatten(read(path.join(directory, file)));
  for (const [key, source] of Object.entries(base)) {
    const value = translated[key];
    if (typeof value !== "string" || !value.trim()) {
      failures.push(`${code}:${key}: missing or empty`);
      continue;
    }
    if (placeholders(value) !== placeholders(source))
      failures.push(`${code}:${key}: interpolation placeholders differ`);
    if (/ZXQ\d+ZXQ/.test(value))
      failures.push(`${code}:${key}: temporary translation marker`);
    if (
      value === source &&
      /[A-Za-z]/.test(source) &&
      exceptions[code]?.[key] !== source
    )
      failures.push(`${code}:${key}: unreviewed English fallback`);
  }
  for (const [key, value] of Object.entries(exceptions[code] ?? {})) {
    if (base[key] !== value || translated[key] !== value)
      failures.push(`${code}:${key}: obsolete literal exception`);
  }
  for (const [key, value] of Object.entries(translated)) {
    if (!key.endsWith("_other")) continue;
    const stem = key.slice(0, -6);
    for (const category of new Intl.PluralRules(code).resolvedOptions()
      .pluralCategories) {
      if (typeof translated[`${stem}_${category}`] !== "string")
        failures.push(`${code}:${stem}: missing plural category ${category}`);
    }
  }
}
if (failures.length) {
  console.error(
    `[translation-coverage] ${failures.length} issues:\n${failures.join("\n")}`
  );
  process.exitCode = 1;
} else
  console.log(
    "[translation-coverage] No missing translations, placeholder mismatches, or missing plural forms."
  );
