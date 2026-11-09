import {
  languageCodeOfName,
  languageNameOfCode,
  prose,
  sameLanguage,
} from "./reply-language.js";
/**
 * The language a text is written in, read on the device: eld's n-gram model
 * (its extra-small database, 60 languages, about 0.02 ms a message, no call).
 * The reply-language check reads the person's words and the model's reply
 * with it, so English against Vietnamese is caught as surely as English
 * against Arabic; and the saved reply language follows what the person
 * writes, so the prompt names their language before the model answers.
 *
 * Only what it reads with confidence counts: at least 20 letters of prose
 * (code, paths and links dropped) and a clear lead over the next language.
 * Tested on chat messages in some 40 languages, that judges about 3 in 4
 * and agrees with a large model on 99% of those; the rest (a greeting,
 * Vietnamese typed without its marks) answer null and are left to the
 * model detection in user-language.ts. The database loads in the background on first use
 * (`loadLanguageModel`); until it has, everything answers null.
 */
import {
  detectMessageLanguage,
  readUserLanguage,
  writeUserLanguage,
} from "./user-language.js";

interface Detector {
  detect: (text: string) => {
    language: string;
    getScores: () => Record<string, number>;
  };
}

/** Below this many letters of prose a text names no language. */
const LANGUAGE_MIN_LETTERS = 20;
/** The lead the best language needs over the next, in eld's scores. */
const LANGUAGE_MIN_LEAD = 0.1;
/** How long a first run waits for the database before going on without it. */
const LANGUAGE_MODEL_WAIT_MS = 3_000;
/** How long a first run waits on the model's reading of a goal it could not read. */
const GOAL_DETECT_TIMEOUT_MS = 4_000;

let detector: Detector | null = null;
let loading: Promise<void> | null = null;

/** Loads the database once; a failed load is tried again on the next use. */
export const loadLanguageModel = (): Promise<void> =>
  (loading ??= import("eld/extrasmall")
    .then((module) => {
      detector = module.eld as Detector;
    })
    .catch(() => {
      loading = null;
    }));

/** Paths, addresses and identifiers read as words of no language. */
const languageProse = (text: string): string =>
  prose(text)
    .replace(/[A-Za-z]:[\\/]\S*/g, " ")
    .replace(/(^|\s)[.~]?\/\S+/g, " ")
    .replace(/\S+@\S+\.\S+/g, " ")
    .replace(/\b[A-Za-z]*[_\d]\S*/g, " ")
    .replace(/[#*_>|[\]()]/g, " ");

/**
 * The ISO 639-1 code of the language a text is written in ("vi", "hu"), or
 * null when it cannot tell: too few letters, no clear lead, or the database
 * not loaded yet.
 */
export const identifyLanguage = (
  text: string,
  minLetters = LANGUAGE_MIN_LETTERS
): string | null => {
  if (detector == null) {
    void loadLanguageModel();
    return null;
  }
  const words = languageProse(text);
  let letters = 0;
  for (const char of words) if (/\p{L}/u.test(char)) letters += 1;
  if (letters < minLetters) return null;
  const result = detector.detect(words);
  const [first, second] = Object.values(result.getScores()).sort(
    (a, b) => b - a
  );
  if (result.language === "" || first == null) return null;
  if (first - (second ?? 0) < LANGUAGE_MIN_LEAD) return null;
  return result.language;
};

/** The code of the user's saved language; null with none, or one no code names. */
export const savedLanguageCode = (): string | null => {
  const saved = readUserLanguage();
  return saved == null ? null : languageCodeOfName(saved.name);
};

/**
 * Saves `code` as the language the user writes in, unless they chose one
 * (`set_user_language`) or the saved one is already it ("Brazilian
 * Portuguese" stays for "pt"). Chinese is left to the model detection, which
 * tells Simplified from Traditional. True when the saved language changed.
 */
const saveLearnt = (code: string): boolean => {
  const saved = readUserLanguage();
  if (saved?.source === "user") return false;
  const savedCode = saved == null ? null : languageCodeOfName(saved.name);
  if (savedCode != null && sameLanguage(savedCode, code)) return false;
  if (code === "zh") return false;
  return writeUserLanguage(languageNameOfCode(code), "detected");
};

/**
 * Keeps the saved reply language with the language the user writes in, so
 * the prompt names it before the model answers. One clear turn sets it when
 * none is saved; a change needs two clear turns in a row, so a pasted English
 * log in a Vietnamese chat moves nothing. The user's own choice never moves.
 * One per engine; read only the user's own words (user-text.ts `ownWords`).
 */
export class LanguageFollower {
  private pending: string | null = null;

  /** Reads one turn's own words; true when the saved language changed. */
  follow(words: string): boolean {
    const code = identifyLanguage(words);
    if (code == null) return false;
    const saved = readUserLanguage();
    if (saved?.source === "user") return false;
    const savedCode = saved == null ? null : languageCodeOfName(saved.name);
    if (savedCode != null && sameLanguage(savedCode, code)) {
      this.pending = null;
      return false;
    }
    if (saved != null && this.pending == null) {
      this.pending = code;
      return false;
    }
    if (saved != null && !sameLanguage(this.pending ?? "", code)) {
      this.pending = code;
      return false;
    }
    this.pending = null;
    return saveLearnt(code);
  }
}

/**
 * A goal the user typed in onboarding: the first words of theirs a bot
 * answers, so their language is settled before the bot speaks and the
 * first-run note names it. Waits briefly for the database, then for the
 * model when the goal is too short or unmarked to read here ("toi muon cai
 * tien code"). An English goal on an app in another language is left to
 * their first message: a few English words are often just the terms
 * ("ai videos", "Study Buddy"). The user's own choice is never moved. Called
 * by the desktop before it writes the first-run note.
 */
export async function learnGoalLanguage(
  goal: string,
  apiKey: string | null,
  appLanguage: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (goal.trim().length === 0 || readUserLanguage()?.source === "user") return;
  const termsOnly = (code: string): boolean =>
    sameLanguage(code, "en") &&
    appLanguage != null &&
    !sameLanguage(appLanguage, "en");
  await Promise.race([
    loadLanguageModel(),
    new Promise((resolve) => setTimeout(resolve, LANGUAGE_MODEL_WAIT_MS)),
  ]);
  const code = identifyLanguage(goal);
  if (code != null) {
    if (!termsOnly(code)) saveLearnt(code);
    return;
  }
  if (apiKey == null || apiKey.trim().length === 0) return;
  const name = await detectMessageLanguage(
    goal,
    apiKey.trim(),
    fetchImpl,
    GOAL_DETECT_TIMEOUT_MS
  );
  if (name == null) return;
  const named = languageCodeOfName(name);
  if (named != null && termsOnly(named)) return;
  const saved = readUserLanguage();
  if (saved?.source === "user") return;
  const savedCode = saved == null ? null : languageCodeOfName(saved.name);
  if (named != null && savedCode != null && sameLanguage(savedCode, named))
    return;
  writeUserLanguage(name, "detected");
}
