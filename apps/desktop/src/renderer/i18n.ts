import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import { durableStorage } from "./lib/durable-storage";
import enUS from "./locales/en-US.json";

export const FALLBACK_LANGUAGE = "en-US";

/**
 * Every locale except the fallback is an `import()`, so each ships as its own
 * chunk; bundling all eleven eagerly cost ~500KB of JSON to serve one language.
 * Spanish is matched explicitly because both translations are regional and
 * declaration order must not decide which dialect a user gets.
 */
const LOADERS: Record<string, () => Promise<{ default: object }>> = {
  "de-DE": () => import("./locales/de-DE.json"),
  "es-ES": () => import("./locales/es-ES.json"),
  "es-419": () => import("./locales/es-419.json"),
  "fr-FR": () => import("./locales/fr-FR.json"),
  "hi-IN": () => import("./locales/hi-IN.json"),
  "id-ID": () => import("./locales/id-ID.json"),
  "it-IT": () => import("./locales/it-IT.json"),
  "ja-JP": () => import("./locales/ja-JP.json"),
  "ko-KR": () => import("./locales/ko-KR.json"),
  "pt-BR": () => import("./locales/pt-BR.json"),
};

export const SUPPORTED_LANGUAGES = [FALLBACK_LANGUAGE, ...Object.keys(LOADERS)];

/**
 * Spain gets `es-ES`; every other Spanish region, and bare `es`, gets the
 * Latin-American `es-419`, the larger region of the two bundles shipped.
 */
export function matchSupportedLanguage(
  languageTags: readonly string[]
): string | undefined {
  for (const tag of languageTags) {
    const normalized = tag.toLowerCase();
    const exact = SUPPORTED_LANGUAGES.find(
      (code) => code.toLowerCase() === normalized
    );
    if (exact) {
      return exact;
    }

    const [base] = normalized.split("-");
    if (base === "es") {
      // Intl.Locale finds the region past a script subtag (`es-Latn-ES`); an
      // invalid injected value still gets the deliberate default.
      let region: string | undefined;
      try {
        region = new Intl.Locale(tag).region;
      } catch {
        region = undefined;
      }
      return region?.toUpperCase() === "ES" ? "es-ES" : "es-419";
    }

    const related = SUPPORTED_LANGUAGES.find(
      (code) => code.split("-")[0].toLowerCase() === base
    );
    if (related) {
      return related;
    }
  }
  return undefined;
}

/** The language the user last chose, as Zustand persisted it. */
function storedLanguage(): string | undefined {
  try {
    const raw = durableStorage.getItem("abacusai-bot-language");
    const code = raw
      ? (JSON.parse(raw) as { state?: { languageCode?: string } }).state
          ?.languageCode
      : undefined;
    return code && SUPPORTED_LANGUAGES.includes(code) ? code : undefined;
  } catch {
    // Corrupt or absent: fall through to the OS languages.
    return undefined;
  }
}

/**
 * Electron populates `navigator.languages` from the system settings, so this
 * needs no main-process round trip.
 */
function systemLanguage(): string | undefined {
  return matchSupportedLanguage(navigator.languages);
}

function applyDocumentLanguage(code: string): void {
  document.documentElement.lang = code;
  document.documentElement.dir = i18n.dir(code);
}

export async function changeLanguage(code: string): Promise<void> {
  const load = LOADERS[code];
  if (load && !i18n.hasResourceBundle(code, "translation")) {
    i18n.addResourceBundle(code, "translation", (await load()).default);
  }
  await i18n.changeLanguage(code);
  applyDocumentLanguage(code);
}

/** Awaited before first render so non-English users see no English flash. */
export async function initI18n(): Promise<void> {
  const language = storedLanguage() ?? systemLanguage() ?? FALLBACK_LANGUAGE;

  await i18n.use(initReactI18next).init({
    resources: { [FALLBACK_LANGUAGE]: { translation: enUS } },
    lng: FALLBACK_LANGUAGE,
    fallbackLng: FALLBACK_LANGUAGE,
    interpolation: { escapeValue: false }, // React already escapes.
    initImmediate: false,
  });

  if (language !== FALLBACK_LANGUAGE) {
    await changeLanguage(language);
  } else {
    applyDocumentLanguage(language);
  }
}

export default i18n;
