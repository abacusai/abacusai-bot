#!/usr/bin/env node

/**
 * Keep all locale JSON files in sync with en-US.json (source of truth).
 *
 * - Same keys in every file (no missing / no extra)
 * - Same key order as en-US
 * - Missing values fall back to en-US
 *
 * Usage:
 *   node scripts/sync-locales.js          # rewrite locale files
 *   node scripts/sync-locales.js --check  # exit 1 if any file is out of sync
 */

import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const LOCALE_DIR = path.join(ROOT, "src/renderer/locales");
const BASE_LOCALE = "en-US.json";
const checkOnly = process.argv.includes("--check");

function loadJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function serializeLocale(obj) {
  return `${JSON.stringify(obj, null, 2)}\n`;
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Recurses. The locale files are nested (every UI string lives under a section
// like `agent`), so a shallow copy would see the section as a non-string
// and replace the whole translated subtree with en-US — silently reverting
// every translation in the file the next time anyone ran this script.
function syncLocale(baseObj, localeObj) {
  const synced = {};
  for (const key of Object.keys(baseObj)) {
    const baseValue = baseObj[key];
    const existing = isPlainObject(localeObj) ? localeObj[key] : undefined;
    if (isPlainObject(baseValue)) {
      synced[key] = syncLocale(
        baseValue,
        isPlainObject(existing) ? existing : {}
      );
    } else {
      synced[key] =
        typeof existing === "string" && existing.trim() !== ""
          ? existing
          : baseValue;
    }
  }
  return synced;
}

// Dotted leaf paths, so the missing/extra report counts real strings rather
// than top-level sections (which made a whole untranslated subtree read as
// "missing 0").
function flattenKeys(obj, prefix = "") {
  const keys = [];
  for (const key of Object.keys(obj)) {
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (isPlainObject(obj[key])) {
      keys.push(...flattenKeys(obj[key], full));
    } else {
      keys.push(full);
    }
  }
  return keys;
}

const SOURCE_DIR = path.join(ROOT, "src/renderer");

// CLDR plural categories i18next appends to a plural key.
const PLURAL_SUFFIXES = ["_one", "_other", "_zero", "_two", "_few", "_many"];

/**
 * Every `t("...")` in the renderer must name a key en-US actually has.
 *
 * The sync above only proves the locale files agree with each other; it cannot
 * see a call site left pointing at a key that was renamed away, which renders
 * as the raw key string in the UI. A bulk rename of the `localCode.*` section
 * is exactly how that happens, and the failure is silent — nothing throws, the
 * user just reads "workspace.modelTier.fast" on a button.
 *
 * Template literals (`t(`workspace.modelTier.${tier}`)`) can't be resolved
 * statically, so the static prefix is required to match at least one real key.
 * That is enough to catch a renamed section, which is the case that bites.
 */
function checkKeyUsage(baseKeys) {
  const known = new Set(baseKeys);
  const problems = [];

  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "locales") {
          walk(full);
        }
      } else if (/\.tsx?$/.test(entry.name)) {
        const source = fs.readFileSync(full, "utf8");
        const rel = path.relative(ROOT, full);

        for (const [, key] of source.matchAll(/\bt\(\s*["']([\w.]+)["']/g)) {
          // A plural key is stored under its CLDR category suffixes
          // (`itemCount_one` / `_other`); the call site names the stem.
          if (
            !(known.has(key) || PLURAL_SUFFIXES.some((s) => known.has(key + s)))
          ) {
            problems.push(
              `${rel}: t("${key}") — no such key in ${BASE_LOCALE}`
            );
          }
        }

        for (const [, prefix] of source.matchAll(/\bt\(\s*`([\w.]*)\$\{/g)) {
          if (prefix && !baseKeys.some((k) => k.startsWith(prefix))) {
            problems.push(
              `${rel}: t(\`${prefix}\${...}\`) — no key in ${BASE_LOCALE} starts with "${prefix}"`
            );
          }
        }
      }
    }
  };
  walk(SOURCE_DIR);

  if (problems.length > 0) {
    console.error(
      `\n[sync-locales] ${problems.length} translation call(s) reference missing keys:`
    );
    for (const problem of problems) {
      console.error(`  ${problem}`);
    }
    process.exit(1);
  }
  console.log("[sync-locales] All t() keys resolve against the base locale.");
}

function main() {
  const basePath = path.join(LOCALE_DIR, BASE_LOCALE);
  if (!fs.existsSync(basePath)) {
    console.error(`[sync-locales] Missing base locale: ${basePath}`);
    process.exit(1);
  }

  const baseObj = loadJson(basePath);
  const baseKeys = flattenKeys(baseObj);
  const localeFiles = fs
    .readdirSync(LOCALE_DIR)
    .filter((f) => f.endsWith(".json") && f !== BASE_LOCALE)
    .sort();

  let changed = 0;
  const report = [];

  for (const file of localeFiles) {
    const filePath = path.join(LOCALE_DIR, file);
    const localeObj = loadJson(filePath);
    const localeKeys = flattenKeys(localeObj);

    const localeKeySet = new Set(localeKeys);
    const baseKeySet = new Set(baseKeys);
    const missing = baseKeys.filter((k) => !localeKeySet.has(k));
    const extra = localeKeys.filter((k) => !baseKeySet.has(k));
    const synced = syncLocale(baseObj, localeObj);
    const nextContent = serializeLocale(synced);
    const prevContent = fs.readFileSync(filePath, "utf8");

    const fileChanged = nextContent !== prevContent;
    if (fileChanged) changed += 1;

    report.push({
      file,
      keys: localeKeys.length,
      missing: missing.length,
      extra: extra.length,
      changed: fileChanged,
    });

    if (!checkOnly && fileChanged) {
      fs.writeFileSync(filePath, nextContent, "utf8");
    }
  }

  console.log(
    `[sync-locales] Base locale ${BASE_LOCALE}: ${baseKeys.length} keys`
  );
  for (const row of report) {
    const status = row.changed ? (checkOnly ? "OUT OF SYNC" : "UPDATED") : "OK";
    console.log(
      `  ${row.file}: ${row.keys} keys, missing ${row.missing}, extra ${row.extra} — ${status}`
    );
  }

  if (checkOnly && changed > 0) {
    console.error(
      `\n[sync-locales] ${changed} locale file(s) out of sync. Run: pnpm --filter @abacus-ai/desktop sync:locales`
    );
    process.exit(1);
  }

  if (!checkOnly) {
    console.log(`\n[sync-locales] Done. ${changed} file(s) updated.`);
  } else {
    console.log("\n[sync-locales] All locale files are in sync.");
  }

  checkKeyUsage(baseKeys);
}

main();
