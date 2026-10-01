/**
 * Language matching (copied from the old renderer's i18n.ts:34-67 with its
 * tests; the old copy stays until cut-over) and the explicit "system" choice
 * (spec 01 §9.2).
 */
import { SUPPORTED_LANGUAGES, type SupportedLanguage } from "#shared/contract";

export const FALLBACK_LANGUAGE: SupportedLanguage = "en-US";

export { type SupportedLanguage };

/**
 * Spain gets `es-ES`; every other Spanish region, and bare `es`, gets the
 * Latin-American `es-419`, the larger region of the two bundles shipped.
 */
export const matchSupportedLanguage = (
  languageTags: readonly string[]
): SupportedLanguage | undefined => {
  for (const tag of languageTags) {
    const normalized = tag.toLowerCase();
    const exact = SUPPORTED_LANGUAGES.find(
      (code) => code.toLowerCase() === normalized
    );
    if (exact) return exact;

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
      (code) => code.split("-")[0]?.toLowerCase() === base
    );
    if (related) return related;
  }
  return undefined;
};

/** `"system"` follows the OS languages; an explicit code stays. */
export const resolveLanguage = (
  pref: "system" | SupportedLanguage,
  systemLanguages: readonly string[] = navigator.languages
): SupportedLanguage =>
  pref === "system"
    ? (matchSupportedLanguage(systemLanguages) ?? FALLBACK_LANGUAGE)
    : pref;
