/**
 * i18n boot for renderer (spec 01 §9.2). The same locale files as the
 * old renderer, reached through `#locales/*`; its own i18next instance, so
 * nothing is shared with the old tree at runtime. `en-US` is bundled; the
 * other ten load on demand as their own chunks.
 */
import { createInstance, type i18n as I18n, type TFunction } from "i18next";
import { initReactI18next } from "react-i18next";

import enUS from "#locales/en-US.json";

import { FALLBACK_LANGUAGE, type SupportedLanguage } from "./languages";

const LOADERS: Record<
  Exclude<SupportedLanguage, "en-US">,
  () => Promise<{ default: object }>
> = {
  "de-DE": () => import("#locales/de-DE.json"),
  "es-ES": () => import("#locales/es-ES.json"),
  "es-419": () => import("#locales/es-419.json"),
  "fr-FR": () => import("#locales/fr-FR.json"),
  "hi-IN": () => import("#locales/hi-IN.json"),
  "id-ID": () => import("#locales/id-ID.json"),
  "it-IT": () => import("#locales/it-IT.json"),
  "ja-JP": () => import("#locales/ja-JP.json"),
  "ko-KR": () => import("#locales/ko-KR.json"),
  "pt-BR": () => import("#locales/pt-BR.json"),
};

export const i18n: I18n = createInstance();

let initialised: Promise<void> | null = null;

/** English only; the user's language follows once prefs are known. */
export const initI18n = (): Promise<void> => {
  initialised ??= i18n
    .use(initReactI18next)
    .init({
      resources: { [FALLBACK_LANGUAGE]: { translation: enUS } },
      lng: FALLBACK_LANGUAGE,
      fallbackLng: FALLBACK_LANGUAGE,
      interpolation: { escapeValue: false },
      initAsync: false,
    })
    .then(() => applyDocumentLanguage(FALLBACK_LANGUAGE));
  return initialised;
};

const applyDocumentLanguage = (code: string): void => {
  document.documentElement.lang = code;
  document.documentElement.dir = i18n.dir(code);
};

export const changeLanguage = async (
  code: SupportedLanguage
): Promise<void> => {
  await initI18n();
  if (
    code !== FALLBACK_LANGUAGE &&
    !i18n.hasResourceBundle(code, "translation")
  ) {
    const bundle = await LOADERS[code as Exclude<SupportedLanguage, "en-US">]();
    i18n.addResourceBundle(code, "translation", bundle.default);
  }
  await i18n.changeLanguage(code);
  applyDocumentLanguage(code);
};

/** For loaders and not-found copy (router context `t`). */
export const fixedT = (): TFunction =>
  i18n.getFixedT(null, "translation") as unknown as TFunction;

export { resolveLanguage } from "./languages";
