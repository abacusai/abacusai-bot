/**
 * Which language a dictated clip is transcribed in, and on which model.
 * The audio decides: Whisper's own language step scores the clip, and the
 * user's language only breaks a close race. Dictation never translates.
 */
import {
  WHISPER_BASE_MODEL_ID,
  WHISPER_SMALL_MODEL_ID,
  type WhisperModelId,
} from "@abacus-ai/contract/voice";

/** One Whisper language code and its probability for the clip. */
export interface LanguageScore {
  code: string;
  p: number;
}

/** A top language this likely needs no hint (the rest share at most 0.2, so it is well ahead). */
export const DICTATION_CONFIDENT = 0.8;
/** The hint may win only among the first few, each at least half as likely as the top. */
const HINT_CANDIDATES = 3;
const FALLBACK_LANGUAGE = "en";
/** One spoken language to Whisper, written in two scripts. */
const HINDUSTANI = new Set(["hi", "ur"]);
const HINDUSTANI_REGIONS: Record<string, string> = { IN: "hi", PK: "ur" };

interface Group {
  codes: string[];
  p: number;
}

/** Hindi and Urdu scored as one language, so the script never splits its confidence. */
const grouped = (scores: readonly LanguageScore[]): Group[] => {
  const groups: Group[] = [];
  let hindustani: Group | null = null;
  for (const { code, p } of [...scores].sort((a, b) => b.p - a.p)) {
    if (!HINDUSTANI.has(code)) {
      groups.push({ codes: [code], p });
    } else if (hindustani == null) {
      hindustani = { codes: [code], p };
      groups.push(hindustani);
    } else {
      hindustani.codes.push(code);
      hindustani.p += p;
    }
  }
  return groups.sort((a, b) => b.p - a.p);
};

/** Hindi or Urdu from the locale tags: any tag's language first, then any tag's region. */
const localeHindustani = (tags: readonly string[]): string | null => {
  const locales = tags.flatMap((tag) => {
    try {
      return [new Intl.Locale(tag.replace(/_/g, "-"))];
    } catch {
      return []; // Not a tag.
    }
  });
  return (
    locales.find((locale) => HINDUSTANI.has(locale.language))?.language ??
    locales
      .map((locale) => HINDUSTANI_REGIONS[locale.region ?? ""])
      .find((code) => code != null) ??
    null
  );
};

/**
 * The language to transcribe in, and whether the audio was confident. A
 * confident top wins; otherwise the user's language wins when it is a close
 * candidate. Hindi or Urdu takes its script from the user's language, then
 * their locale, else Hindi: the audio cannot tell the two apart (base splits
 * a Hindi clip 0.50 Urdu to 0.45 Hindi). The reply-language resolver reads
 * Hindi as English today, so the user's-language step only decides once the
 * resolver can return Hindi or Urdu.
 */
export const chooseDictationLanguage = (
  scores: readonly LanguageScore[],
  user: { code: string | null; localeTags: readonly string[] }
): { language: string; confident: boolean } => {
  const groups = grouped(scores);
  const top = groups[0];
  if (top == null)
    return { language: user.code ?? FALLBACK_LANGUAGE, confident: false };
  const confident = top.p >= DICTATION_CONFIDENT;
  const language = scriptOf(groups, top, confident, user);
  return { language, confident };
};

const scriptOf = (
  groups: readonly Group[],
  top: Group,
  confident: boolean,
  user: { code: string | null; localeTags: readonly string[] }
): string => {
  const hint = user.code;
  const hinted =
    confident || hint == null
      ? undefined
      : groups
          .slice(0, HINT_CANDIDATES)
          .find((group) => group.p * 2 >= top.p && group.codes.includes(hint));
  const pick = hinted ?? top;
  if (!pick.codes.some((code) => HINDUSTANI.has(code))) return pick.codes[0]!;
  if (hint != null && HINDUSTANI.has(hint)) return hint;
  return localeHindustani(user.localeTags) ?? "hi";
};

/**
 * The Whisper code for a language's English name ("French", "Brazilian
 * Portuguese"), among the codes the model supports; null when none matches.
 */
export const dictationLanguageCode = (
  name: string,
  supported: readonly string[]
): string | null => {
  const wanted = name.trim().toLowerCase();
  if (wanted.length === 0) return null;
  const names = new Intl.DisplayNames(["en"], { type: "language" });
  for (const code of supported) {
    let english: string | undefined;
    try {
      english = names.of(code)?.toLowerCase();
    } catch {
      continue;
    }
    if (english == null || english === code) continue;
    if (wanted === english || wanted.endsWith(` ${english}`)) return code;
  }
  return null;
};

/** English on base; every other language on small once it is on disk. */
export const dictationModel = (
  language: string,
  smallReady: boolean
): WhisperModelId =>
  language !== FALLBACK_LANGUAGE && smallReady
    ? WHISPER_SMALL_MODEL_ID
    : WHISPER_BASE_MODEL_ID;
