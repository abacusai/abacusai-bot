/**
 * The prefs row's language is `"system"` or a locale the app ships, so the
 * list in the contract must be the locale files on disk.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { PrefsPatchSchema } from "./db";
import {
  languageNameTag,
  matchSupportedLanguage,
  resolveAppLanguage,
} from "./languages";
import { SUPPORTED_LANGUAGES } from "./rows";

describe("supported languages", () => {
  it("are exactly the locale files the renderer ships", () => {
    const locales = readdirSync(
      join(import.meta.dirname, "../../../../apps/web/src/locales")
    )
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.replace(/\.json$/, ""))
      .sort();

    expect([...SUPPORTED_LANGUAGES].sort()).toEqual(locales);
  });

  it("accept an explicit system choice, a shipped code, and nothing else", () => {
    expect(v.is(PrefsPatchSchema, { language: "system" })).toBe(true);
    expect(v.is(PrefsPatchSchema, { language: "de-DE" })).toBe(true);
    expect(v.is(PrefsPatchSchema, { language: "de" })).toBe(false);
    expect(v.is(PrefsPatchSchema, { language: "tlh-KL" })).toBe(false);
    // Hindi is not a UI language: a saved pick reads back as "system".
    expect(v.is(PrefsPatchSchema, { language: "hi-IN" })).toBe(false);
    expect(SUPPORTED_LANGUAGES).not.toContain("hi-IN");
    // Unknown keys are refused, as the spec's prefs patch requires.
    expect(v.is(PrefsPatchSchema, { colour: "red" })).toBe(false);
  });

  it("are never Hindi: a Hindi OS matches no UI locale", () => {
    expect(matchSupportedLanguage(["hi-IN"])).toBeUndefined();
    expect(matchSupportedLanguage(["hi"])).toBeUndefined();
  });
});

describe("Chinese, by the script its readers read", () => {
  it.each([
    ["zh", "zh-CN"],
    ["zh-CN", "zh-CN"],
    ["zh-SG", "zh-CN"],
    ["zh-MY", "zh-CN"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hans-CN", "zh-CN"],
    ["zh-Hans-SG", "zh-CN"],
    // A script outranks a region.
    ["zh-Hans-HK", "zh-CN"],
    ["zh-Hans-TW", "zh-CN"],
    ["zh-TW", "zh-TW"],
    ["zh-HK", "zh-TW"],
    ["zh-MO", "zh-TW"],
    ["zh-Hant", "zh-TW"],
    ["zh-Hant-TW", "zh-TW"],
    ["zh-Hant-HK", "zh-TW"],
    ["zh-Hant-MO", "zh-TW"],
    ["zh-Hant-CN", "zh-TW"],
    ["zh_TW", "zh-TW"],
    ["ZH-hk", "zh-TW"],
    // An invalid value gets the deliberate default, as Spanish does.
    ["zh-!!", "zh-CN"],
  ])("%s reads %s", (tag, expected) => {
    expect(matchSupportedLanguage([tag])).toBe(expected);
  });

  it("names each by its script, and every other locale by its own code", () => {
    expect(languageNameTag("zh-CN")).toBe("zh-Hans");
    expect(languageNameTag("zh-TW")).toBe("zh-Hant");
    expect(languageNameTag("tr-TR")).toBe("tr-TR");
  });

  it("does not move the Spanish rule", () => {
    expect(matchSupportedLanguage(["es_ES"])).toBe("es-ES");
    expect(matchSupportedLanguage(["es-Latn-ES"])).toBe("es-ES");
    expect(matchSupportedLanguage(["es-!!"])).toBe("es-419");
  });
});

describe("the app's language, one resolution for the UI, the menus and the agent", () => {
  it.each([
    [
      "an explicit pick, whatever the OS says",
      "tr-TR",
      ["pt-BR"],
      { ui: "tr-TR", tag: "tr-TR" },
    ],
    [
      "the OS's first language for system",
      "system",
      ["de-DE", "en-US"],
      { ui: "de-DE", tag: "de-DE" },
    ],
    [
      "a first-launch prefs row with none set",
      undefined,
      ["pt-BR"],
      { ui: "pt-BR", tag: "pt-BR" },
    ],
    [
      "the first shipped one for the UI, the first one for replies",
      "system",
      ["bn-BD", "en-US"],
      { ui: "en-US", tag: "bn-BD" },
    ],
    [
      "Spain's Spanish, and the rest of Spanish",
      "system",
      ["es-MX"],
      { ui: "es-419", tag: "es-MX" },
    ],
    [
      "Traditional for a Hong Kong OS, whose tag the agent still gets",
      "system",
      ["zh-Hant-HK", "en-US"],
      { ui: "zh-TW", tag: "zh-Hant-HK" },
    ],
    [
      "Simplified for bare Chinese",
      "system",
      ["zh"],
      { ui: "zh-CN", tag: "zh" },
    ],
    [
      "an English UI on a Hindi OS (the agent reads hi as English too)",
      "system",
      ["hi-IN"],
      { ui: "en-US", tag: "hi-IN" },
    ],
    [
      "English with no languages at all",
      "system",
      [""],
      { ui: "en-US", tag: "en-US" },
    ],
  ] as const)("takes %s", (_label, pick, languages, expected) => {
    expect(resolveAppLanguage(pick, languages)).toEqual(expected);
  });
});
