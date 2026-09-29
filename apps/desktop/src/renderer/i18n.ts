import i18n from "i18next";
import { initReactI18next } from "react-i18next";

import {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  matchSupportedLanguage,
} from "../shared/languages";
import { durableStorage } from "./lib/durable-storage";
import enUS from "./locales/en-US.json";
export {
  FALLBACK_LANGUAGE,
  SUPPORTED_LANGUAGES,
  matchSupportedLanguage,
} from "../shared/languages";

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
 * The preload captures Electron’s OS preference list before first render.
 * Browser previews fall back to navigator.languages.
 */
function systemLanguage(): string | undefined {
  return matchSupportedLanguage(
    window.api?.systemLanguages ?? navigator.languages
  );
}

export function initialLanguage(): string {
  return storedLanguage() ?? systemLanguage() ?? FALLBACK_LANGUAGE;
}

function applyDocumentLanguage(code: string): void {
  document.documentElement.lang = code;
  document.documentElement.dir = i18n.dir(code);
}

let languageRequest = 0;
export async function changeLanguage(code: string): Promise<void> {
  if (!SUPPORTED_LANGUAGES.includes(code)) return;
  const request = ++languageRequest;
  const load = LOADERS[code];
  if (load && !i18n.hasResourceBundle(code, "translation")) {
    i18n.addResourceBundle(code, "translation", (await load()).default);
  }
  if (request !== languageRequest) return;
  await i18n.changeLanguage(code);
  applyDocumentLanguage(code);
  await window.api?.setAppLanguage?.(code);
}

/** Awaited before first render so non-English users see no English flash. */
export async function initI18n(): Promise<void> {
  const language = initialLanguage();

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
