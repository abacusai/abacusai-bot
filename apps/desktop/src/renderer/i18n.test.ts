import { afterEach, describe, expect, it, vi } from "vitest";

import i18n, { changeLanguage, initI18n, matchSupportedLanguage } from "./i18n";
import { durableStorage } from "./lib/durable-storage";

vi.mock("./lib/durable-storage", () => {
  const values = new Map<string, string>();
  return {
    durableStorage: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => {
        values.set(key, value);
      },
      removeItem: (key: string) => {
        values.delete(key);
      },
    },
  };
});

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

describe("initial language", () => {
  afterEach(() => {
    durableStorage.removeItem("abacusai-bot-language");
    vi.restoreAllMocks();
    vi.resetModules();
  });

  it("uses the OS language before first render and in Settings", async () => {
    durableStorage.removeItem("abacusai-bot-language");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-AT"]);
    await initI18n();
    expect(i18n.language).toBe("de-DE");
    expect(document.documentElement.lang).toBe("de-DE");
    const { useLanguageStore } = await import("./stores/language-store");
    expect(useLanguageStore.getState().languageCode).toBe("de-DE");
    useLanguageStore.getState().setLanguageCode("en-US");
    expect(i18n.language).toBe("en-US");
  });

  it("preserves an explicit language choice over the OS preference", async () => {
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["de-DE"]);
    durableStorage.setItem(
      "abacusai-bot-language",
      JSON.stringify({ state: { languageCode: "ja-JP" } })
    );
    await initI18n();
    expect(i18n.language).toBe("ja-JP");
  });

  it("falls back to English for unsupported system languages", async () => {
    durableStorage.removeItem("abacusai-bot-language");
    vi.spyOn(navigator, "languages", "get").mockReturnValue(["zh-CN"]);
    await initI18n();
    expect(i18n.language).toBe("en-US");
  });
});

describe("language changes", () => {
  it("keeps the last selection when lazy language loads overlap", async () => {
    await initI18n();
    await Promise.all([changeLanguage("it-IT"), changeLanguage("fr-FR")]);
    expect(i18n.language).toBe("fr-FR");
    expect(document.documentElement.lang).toBe("fr-FR");
  });

  it("uses Electron's system preference list over Chromium defaults", async () => {
    const previous = window.api;
    window.api = { ...previous, systemLanguages: ["ko-KR"] };
    try {
      durableStorage.removeItem("abacusai-bot-language");
      vi.spyOn(navigator, "languages", "get").mockReturnValue(["en-US"]);
      await initI18n();
      expect(i18n.language).toBe("ko-KR");
    } finally {
      window.api = previous;
      vi.restoreAllMocks();
    }
  });
});
