/**
 * The prefs row's language is `"system"` or a locale the app ships, so the
 * list in the contract must be the locale files on disk.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";

import * as v from "valibot";
import { describe, expect, it } from "vitest";

import { PrefsPatchSchema } from "./db";
import { SUPPORTED_LANGUAGES } from "./rows";

describe("supported languages", () => {
  it("are exactly the locale files the renderer ships", () => {
    const locales = readdirSync(
      join(import.meta.dirname, "../../renderer/locales")
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
    // Unknown keys are refused, as the spec's prefs patch requires.
    expect(v.is(PrefsPatchSchema, { colour: "red" })).toBe(false);
  });
});
