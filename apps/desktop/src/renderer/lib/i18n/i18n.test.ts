/** R1-T16: language matching, the explicit "system" choice, keys and the keymap. */
import { describe, expect, it } from "vitest";

import enUS from "#locales/en-US.json";

import { matchSupportedLanguage, resolveLanguage } from "./languages";

type Tree = { [key: string]: string | Tree };

const flatten = (tree: Tree, prefix = "", out = new Map<string, string>()) => {
  for (const [key, value] of Object.entries(tree)) {
    const full = prefix === "" ? key : `${prefix}.${key}`;
    if (typeof value === "string") out.set(full, value);
    else flatten(value, full, out);
  }
  return out;
};

const keymap = JSON.parse(
  Object.values(
    import.meta.glob<string>("../../../../scripts/locale-keymap.json", {
      query: "?raw",
      import: "default",
      eager: true,
    })
  )[0] ?? "{}"
) as Record<string, string>;

const keys = flatten(enUS as unknown as Tree);

/** i18next's plural suffixes (CLDR categories); `t(key, { count })` reads them. */
const PLURAL_SUFFIXES = ["zero", "one", "two", "few", "many", "other"];

/** A key `t()` can resolve: itself, or a plural family with `_other`. */
const resolves = (key: string): boolean =>
  keys.has(key) || keys.has(`${key}_other`);

// Every source file of renderer, as text, for the key scan.
const sources = import.meta.glob<string>(
  [
    "../../**/*.{ts,tsx}",
    "!../../**/*.test.*",
    "!../../ui/**",
    "!../../**/*.d.ts",
  ],
  {
    query: "?raw",
    import: "default",
    eager: true,
  }
);

describe("matchSupportedLanguage", () => {
  it.each([
    [["de-DE"], "de-DE"],
    [["de"], "de-DE"],
    [["es-MX"], "es-419"],
    [["es-ES"], "es-ES"],
    [["es-Latn-ES"], "es-ES"],
    [["es"], "es-419"],
    [["xx", "fr-CA"], "fr-FR"],
    [["pt-PT"], "pt-BR"],
    [["xx"], undefined],
  ])("%o → %s", (tags, expected) => {
    expect(matchSupportedLanguage(tags)).toBe(expected);
  });
});

describe("resolveLanguage", () => {
  it("follows the OS for system", () => {
    expect(resolveLanguage("system", ["de-DE"])).toBe("de-DE");
    expect(resolveLanguage("system", ["xx"])).toBe("en-US");
  });

  it("keeps an explicit en-US on a German OS", () => {
    expect(resolveLanguage("en-US", ["de-DE"])).toBe("en-US");
  });
});

describe("keys", () => {
  it("every static t() key in renderer exists in en-US", () => {
    const missing: string[] = [];
    const unread = Object.entries(sources)
      .filter(([, source]) => typeof source !== "string")
      .map(([file]) => file);
    expect(unread).toEqual([]);
    for (const [file, source] of Object.entries(sources))
      for (const [, key] of source.matchAll(/\bt\(\s*"([\w.-]+)"/g))
        if (!resolves(key!)) missing.push(`${file}: ${key}`);
    expect(missing).toEqual([]);
  });

  it("a plural family has no base key and an `_other` form", () => {
    const families = new Set<string>();
    for (const key of keys.keys()) {
      const match = /^(.+)_([a-z]+)$/.exec(key);
      if (match != null && PLURAL_SUFFIXES.includes(match[2]!))
        families.add(match[1]!);
    }
    const problems: string[] = [];
    for (const family of families) {
      if (!keys.has(`${family}_other`)) problems.push(`${family}: no _other`);
      // The old renderer's `workspace.preview.pptxWarnings` predates this rule.
      if (keys.has(family) && !family.startsWith("workspace."))
        problems.push(`${family}: base key beside its plural forms`);
    }
    expect(problems).toEqual([]);
  });

  it("resolves a counted key to its plural forms", async () => {
    const { default: i18next } = await import("i18next");
    const instance = i18next.createInstance();
    await instance.init({
      lng: "en-US",
      resources: { "en-US": { translation: enUS } },
      interpolation: { escapeValue: false },
    });
    expect(instance.t("chat.busy.tools", { count: 1 })).toBe("Running 1 tool");
    expect(instance.t("chat.busy.tools", { count: 3 })).toBe("Running 3 tools");
  });

  it("has a rail label per area, the settings page titles and every panel tab", () => {
    for (const area of [
      "bots",
      "sessions",
      "routines",
      "artifacts",
      "library",
      "settings",
    ])
      expect(keys.has(`shell.rail.${area}`), area).toBe(true);
    for (const page of [
      "general",
      "appearance",
      "notifications",
      "memory",
      "usage",
      "account",
      "models",
      "environment",
      "about",
    ])
      expect(keys.has(`settings.pages.${page}`), page).toBe(true);
    for (const tab of [
      "changes",
      "terminal",
      "files",
      "browser",
      "memory",
      "details",
      "agent",
    ])
      expect(keys.has(`shell.panel.tabs.${tab}`), tab).toBe(true);
  });

  it("keymap entries point from new keys to existing old keys", () => {
    for (const [newKey, oldKey] of Object.entries(keymap)) {
      if (newKey === "$comment") continue;
      expect(keys.has(newKey), newKey).toBe(true);
      expect(keys.has(oldKey), oldKey).toBe(true);
    }
  });
});
