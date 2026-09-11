import { describe, expect, it } from "vitest";

import { matchSupportedLanguage } from "./i18n";

describe("matchSupportedLanguage", () => {
  it.each([
    ["es-ES", "es-ES"],
    ["es-Latn-ES", "es-ES"],
    ["es-419", "es-419"],
    ["es-MX", "es-419"],
    ["es-AR", "es-419"],
    ["es-CO", "es-419"],
    ["es", "es-419"],
    ["de-AT", "de-DE"],
  ])("matches %s to %s", (requested, expected) => {
    expect(matchSupportedLanguage([requested])).toBe(expected);
  });

  it("respects the OS preference order", () => {
    expect(matchSupportedLanguage(["zh-CN", "es-MX", "de-DE"])).toBe("es-419");
  });

  it("returns undefined when none of the requested languages are supported", () => {
    expect(matchSupportedLanguage(["zh-CN", "nl-NL"])).toBeUndefined();
  });
});
