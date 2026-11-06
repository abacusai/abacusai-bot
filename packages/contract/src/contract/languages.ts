/**
 * The app's language, resolved once for everything that shows or says it:
 * the UI locale (renderer and native menus) and the tag the agent's reply
 * fallback starts from. The user's explicit pick wins; otherwise the OS's
 * preferred languages, in order. Hindi is not a UI locale, so an OS set to
 * Hindi gets the English UI, and the agent reads a Hindi tag as English.
 */
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "./rows";

export const FALLBACK_LANGUAGE: SupportedLanguage = "en-US";

/** Where Chinese is read in Traditional characters when a tag names no script. */
const TRADITIONAL_CHINESE_REGIONS = new Set(["TW", "HK", "MO"]);

/**
 * A tag's script and region; Intl.Locale finds a region past a script subtag
 * (`es-Latn-ES`). An invalid injected value has neither, so it still gets the
 * deliberate default.
 */
const tagParts = (tag: string): { script?: string; region?: string } => {
  try {
    const { script, region } = new Intl.Locale(tag);
    return { script, region };
  } catch {
    return {};
  }
};

/**
 * The first tag a shipped locale serves. Spain gets `es-ES`; every other
 * Spanish region, and bare `es`, gets the Latin-American `es-419`, the
 * larger region of the two bundles shipped. Chinese goes by its script, and
 * a tag with none by its region: Taiwan, Hong Kong and Macau read Traditional
 * (`zh-TW`); bare `zh` and everywhere else read Simplified (`zh-CN`). A script
 * outranks a region, so `zh-Hans-HK` stays Simplified.
 */
export const matchSupportedLanguage = (
  languageTags: readonly string[]
): SupportedLanguage | undefined => {
  for (const rawTag of languageTags) {
    // A POSIX locale writes `zh_TW`.
    const tag = rawTag.replace(/_/g, "-");
    const normalized = tag.toLowerCase();
    const exact = SUPPORTED_LANGUAGES.find(
      (code) => code.toLowerCase() === normalized
    );
    if (exact) return exact;

    const [base] = normalized.split("-");
    if (base === "es") {
      return tagParts(tag).region === "ES" ? "es-ES" : "es-419";
    }
    if (base === "zh") {
      const { script, region } = tagParts(tag);
      const traditional =
        script != null
          ? script === "Hant"
          : TRADITIONAL_CHINESE_REGIONS.has(region ?? "");
      return traditional ? "zh-TW" : "zh-CN";
    }

    const related = SUPPORTED_LANGUAGES.find(
      (code) => code.split("-")[0]?.toLowerCase() === base
    );
    if (related) return related;
  }
  return undefined;
};

/**
 * The tag to ask Intl.DisplayNames for a locale's name. Chinese is named by
 * its script: "繁體中文", where `zh-TW` itself would read "中文（台灣）".
 */
export const languageNameTag = (code: SupportedLanguage): string =>
  code === "zh-CN" ? "zh-Hans" : code === "zh-TW" ? "zh-Hant" : code;

export interface AppLanguage {
  /** The locale the UI and the native menus are shown in. */
  ui: SupportedLanguage;
  /**
   * The language as a BCP 47 tag, a locale the app ships or not ("bn-BD"):
   * what the agent's replies fall back to (ABACUSAI_BOT_LOCALE).
   */
  tag: string;
}

/** The user's explicit pick, else the OS's preferred languages, else English. */
export const resolveAppLanguage = (
  pref: "system" | SupportedLanguage | null | undefined,
  systemLanguages: readonly string[]
): AppLanguage => {
  if (pref != null && pref !== "system") return { ui: pref, tag: pref };
  const tags = systemLanguages.filter((tag) => tag.trim().length > 0);
  return {
    ui: matchSupportedLanguage(tags) ?? FALLBACK_LANGUAGE,
    tag: tags[0] ?? FALLBACK_LANGUAGE,
  };
};
