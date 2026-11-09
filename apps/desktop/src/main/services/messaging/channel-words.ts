/**
 * The words a chat app hears from the app itself (a failed turn, the credit
 * wall), in the person's language: the app's own locale files, so a line is
 * translated once for the card and the chat alike. The language is the one
 * the bot already answers in (user-language.json), else the app's, else
 * English; a key a locale lacks reads in English. The main process's other
 * words (the first-run note, native menus and dialogs) load the same way.
 */
import type { PlanT } from "@abacus-ai/contract/billing-plan";
import { matchSupportedLanguage } from "@abacus-ai/contract/contract/languages";
import type { SupportedLanguage } from "@abacus-ai/contract/contract/rows";

import enUS from "#locales/en-US.json";

type Tree = { [key: string]: string | Tree };

const LOADERS: Record<
  Exclude<SupportedLanguage, "en-US">,
  () => Promise<{ default: unknown }>
> = {
  "de-DE": () => import("#locales/de-DE.json"),
  "es-ES": () => import("#locales/es-ES.json"),
  "es-419": () => import("#locales/es-419.json"),
  "fr-FR": () => import("#locales/fr-FR.json"),
  "id-ID": () => import("#locales/id-ID.json"),
  "it-IT": () => import("#locales/it-IT.json"),
  "ja-JP": () => import("#locales/ja-JP.json"),
  "ko-KR": () => import("#locales/ko-KR.json"),
  "nl-NL": () => import("#locales/nl-NL.json"),
  "pl-PL": () => import("#locales/pl-PL.json"),
  "pt-BR": () => import("#locales/pt-BR.json"),
  "tr-TR": () => import("#locales/tr-TR.json"),
  "zh-CN": () => import("#locales/zh-CN.json"),
  "zh-TW": () => import("#locales/zh-TW.json"),
};

/**
 * The stored language's English name (as set_user_language and detection
 * write it) to the locale its lines come from.
 */
const LANGUAGE_LOCALES: Record<string, SupportedLanguage> = {
  english: "en-US",
  german: "de-DE",
  spanish: "es-419",
  "spanish (spain)": "es-ES",
  "castilian spanish": "es-ES",
  french: "fr-FR",
  indonesian: "id-ID",
  italian: "it-IT",
  japanese: "ja-JP",
  korean: "ko-KR",
  dutch: "nl-NL",
  flemish: "nl-NL",
  polish: "pl-PL",
  portuguese: "pt-BR",
  "brazilian portuguese": "pt-BR",
  turkish: "tr-TR",
};

/** Names of Chinese, and those of them that are read in Traditional. */
const CHINESE_NAME = /chinese|mandarin|cantonese/;
const TRADITIONAL_NAME = /traditional|taiwan|hong kong|macau|cantonese/;

/**
 * A language name's locale: "Turkish", a regional name such as "European
 * Spanish" or "American English" by its last word, or Chinese by its script.
 */
const namedLocale = (name: string): SupportedLanguage | undefined => {
  const lower = name.trim().toLowerCase();
  if (lower === "european spanish") return "es-ES";
  if (CHINESE_NAME.test(lower))
    return TRADITIONAL_NAME.test(lower) ? "zh-TW" : "zh-CN";
  return (
    LANGUAGE_LOCALES[lower] ?? LANGUAGE_LOCALES[lower.split(" ").at(-1) ?? ""]
  );
};

/**
 * The locale a chat-app line (or the app's own first-run note) is written
 * in: the language the bot answers this person in, else the app's own,
 * else English. Plain "Chinese" names no script, so a Traditional app says
 * which.
 */
export function channelLocale(
  userLanguage: string | null,
  appLanguage: string | null
): SupportedLanguage {
  const named = userLanguage != null ? namedLocale(userLanguage) : undefined;
  const app =
    appLanguage != null ? matchSupportedLanguage([appLanguage]) : undefined;
  const anyChinese =
    named === "zh-CN" && !/simplified/i.test(userLanguage ?? "");
  if (anyChinese && app === "zh-TW") return app;
  return named ?? app ?? "en-US";
}

const lookup = (tree: unknown, key: string): string | undefined => {
  let node: unknown = tree;
  for (const part of key.split(".")) {
    if (node == null || typeof node !== "object") return undefined;
    node = (node as Tree)[part];
  }
  return typeof node === "string" ? node : undefined;
};

const interpolate = (
  text: string,
  values: Record<string, string | number> = {}
): string =>
  text.replace(/\{\{(\w+)\}\}/g, (match, name: string) =>
    values[name] != null ? String(values[name]) : match
  );

/** The translator for one locale, English underneath it. */
export interface ChannelWords {
  locale: SupportedLanguage;
  t: PlanT;
}

const loaded = new Map<SupportedLanguage, unknown>([["en-US", enUS]]);

export async function channelWords(
  locale: SupportedLanguage
): Promise<ChannelWords> {
  if (!loaded.has(locale) && locale !== "en-US") {
    try {
      loaded.set(locale, (await LOADERS[locale]()).default);
    } catch {
      // A locale that will not load reads in English.
      loaded.set(locale, enUS);
    }
  }
  return loadedWords(locale);
}

/**
 * The translator for a locale already loaded by `channelWords`, English
 * until it is: for callers that cannot wait (a context menu being built).
 */
export function loadedWords(locale: SupportedLanguage): ChannelWords {
  const tree = loaded.get(locale) ?? enUS;
  const plural = new Intl.PluralRules(locale);
  const find = (key: string): string | undefined =>
    lookup(tree, key) ?? lookup(enUS, key);
  return {
    locale,
    // A numeric `count` picks the key's plural form, as i18next does.
    t: (key, values) => {
      const count = values?.count;
      const text =
        typeof count === "number"
          ? (find(`${key}_${plural.select(count)}`) ?? find(`${key}_other`))
          : undefined;
      return interpolate(text ?? find(key) ?? key, values);
    },
  };
}
