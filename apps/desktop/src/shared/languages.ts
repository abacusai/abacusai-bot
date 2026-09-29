export const FALLBACK_LANGUAGE = "en-US";
export const SUPPORTED_LANGUAGES = [
  "en-US",
  "de-DE",
  "es-ES",
  "es-419",
  "fr-FR",
  "hi-IN",
  "id-ID",
  "it-IT",
  "ja-JP",
  "ko-KR",
  "pt-BR",
];

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
