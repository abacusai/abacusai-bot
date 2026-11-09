/**
 * The language a reply is written in, judged against the person it answers.
 * A model can drift into another language after a run of tool results; the
 * prompt asks it not to, and this check lets the turn continue with a repair
 * when it does anyway. Two readings, one decision: the script (a code-point
 * range, so Latin against Han, Arabic or Cyrillic needs nothing else), and,
 * within one script, the language itself (English against Vietnamese or
 * Hungarian), read by the device's language model that the engine passes in
 * (`identify`, language-id.ts). Code and the app's reminders are left out,
 * and the reply is judged against the person's own words over recent turns
 * (`RecentOwnWords`), never one run's. No imports: the hosted app reads it.
 */

export type Script =
  | "latin"
  | "cjk"
  | "cyrillic"
  | "arabic"
  | "hebrew"
  | "greek"
  | "armenian"
  | "georgian"
  | "ethiopic"
  | "devanagari"
  | "bengali"
  | "gurmukhi"
  | "gujarati"
  | "oriya"
  | "tamil"
  | "telugu"
  | "kannada"
  | "malayalam"
  | "sinhala"
  | "thai"
  | "lao"
  | "khmer"
  | "myanmar";

/** ISO 15924 code per script, as `Intl.Locale#maximize` names them. */
const SCRIPT_CODES: Record<Script, readonly string[]> = {
  latin: ["Latn"],
  cjk: ["Hans", "Hant", "Hani", "Jpan", "Hira", "Kana", "Kore", "Hang"],
  cyrillic: ["Cyrl"],
  arabic: ["Arab"],
  hebrew: ["Hebr"],
  greek: ["Grek"],
  armenian: ["Armn"],
  georgian: ["Geor"],
  ethiopic: ["Ethi"],
  devanagari: ["Deva"],
  bengali: ["Beng"],
  gurmukhi: ["Guru"],
  gujarati: ["Gujr"],
  oriya: ["Orya"],
  tamil: ["Taml"],
  telugu: ["Telu"],
  kannada: ["Knda"],
  malayalam: ["Mlym"],
  sinhala: ["Sinh"],
  thai: ["Thai"],
  lao: ["Laoo"],
  khmer: ["Khmr"],
  myanmar: ["Mymr"],
};

const SCRIPT_PATTERNS: ReadonlyArray<readonly [Script, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  [
    "cjk",
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  ],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["greek", /\p{Script=Greek}/u],
  ["armenian", /\p{Script=Armenian}/u],
  ["georgian", /\p{Script=Georgian}/u],
  ["ethiopic", /\p{Script=Ethiopic}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["bengali", /\p{Script=Bengali}/u],
  ["gurmukhi", /\p{Script=Gurmukhi}/u],
  ["gujarati", /\p{Script=Gujarati}/u],
  ["oriya", /\p{Script=Oriya}/u],
  ["tamil", /\p{Script=Tamil}/u],
  ["telugu", /\p{Script=Telugu}/u],
  ["kannada", /\p{Script=Kannada}/u],
  ["malayalam", /\p{Script=Malayalam}/u],
  ["sinhala", /\p{Script=Sinhala}/u],
  ["thai", /\p{Script=Thai}/u],
  ["lao", /\p{Script=Lao}/u],
  ["khmer", /\p{Script=Khmer}/u],
  ["myanmar", /\p{Script=Myanmar}/u],
];

/** Below this many letters a text says nothing about its language. */
const MIN_LETTERS = 20;
/** A script has to carry this share of the letters to be "the" script. */
const DOMINANT_SHARE = 0.6;
/**
 * Han in a reply counts as drift at this share, under DOMINANT_SHARE on
 * purpose: a Chinese answer to an English question is still Chinese when
 * half its letters are the English terms inside it. Only for Han: any other
 * script that small is a quote or a name.
 */
const FOREIGN_SHARE = 0.2;
/** A script in the person's words counts from this many letters, or this share. */
const USED_LETTERS = 5;
const USED_SHARE = 0.1;
/** An earlier message counts a script it carries at this share. */
const RECENT_SHARE = 0.25;

/** Code, links, reminders and thinking: none of it is prose in a language. */
export const prose = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, " ")
    .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/g, " ")
    .replace(/https?:\/\/\S+/g, " ");

interface ScriptTally {
  counts: Map<Script, number>;
  letters: number;
}

/** Letters per script, prose only. */
const scriptCounts = (text: string): ScriptTally => {
  const counts = new Map<Script, number>();
  let letters = 0;
  for (const char of prose(text)) {
    if (!/\p{L}/u.test(char)) continue;
    letters += 1;
    for (const [script, pattern] of SCRIPT_PATTERNS) {
      if (pattern.test(char)) {
        counts.set(script, (counts.get(script) ?? 0) + 1);
        break;
      }
    }
  }
  return { counts, letters };
};

const dominantOf = ({ counts, letters }: ScriptTally): Script | null => {
  if (letters < MIN_LETTERS) return null;
  let best: Script | null = null;
  let bestCount = 0;
  for (const [script, count] of counts) {
    if (count > bestCount) {
      best = script;
      bestCount = count;
    }
  }
  return best != null && bestCount / letters >= DOMINANT_SHARE ? best : null;
};

/** The script most of a text's letters are in, or null when none is clear. */
export const dominantScript = (text: string): Script | null =>
  dominantOf(scriptCounts(text));

/**
 * Whether a text has enough letters to tell its language: a sentence, or a
 * few letters of a script other than Latin. "hi" or a link does not.
 */
export const namesItsLanguage = (text: string): boolean => {
  const { counts, letters } = scriptCounts(text);
  return letters >= MIN_LETTERS || letters - (counts.get("latin") ?? 0) >= 4;
};

const scriptOfCode = (code: string): Script | null => {
  for (const [script, codes] of Object.entries(SCRIPT_CODES))
    if (codes.includes(code)) return script as Script;
  return null;
};

const LANGUAGE_ALIASES: Record<string, string> = {
  // Blends a model names romanized typing by: written in the base language's script.
  hinglish: "hi",
  banglish: "bn",
  benglish: "bn",
  gujlish: "gu",
  tanglish: "ta",
  urdish: "ur",
  bengali: "bn",
  farsi: "fa",
  oriya: "or",
  sinhalese: "si",
  mandarin: "zh",
  cantonese: "zh",
};

/**
 * Every language Intl can name, by its English name and its own ("urdu",
 * "اردو"), with the script it is written in. Built once.
 */
let languageNames: Map<string, Script> | null = null;
/** The same names, to the code each names. Built with them. */
const languageCodes = new Map<string, string>();
const namedLanguages = (): Map<string, Script> => {
  if (languageNames != null) return languageNames;
  const english = new Intl.DisplayNames(["en"], { type: "language" });
  const names = new Map<string, Script>();
  const letters = "abcdefghijklmnopqrstuvwxyz";
  for (const a of letters)
    for (const b of letters) {
      const code = a + b;
      try {
        const script = scriptOfCode(
          new Intl.Locale(code).maximize().script ?? ""
        );
        const name = english.of(code);
        if (script == null || name == null || name === code) continue;
        const own = new Intl.DisplayNames([code], { type: "language" }).of(
          code
        );
        for (const each of [name, own])
          if (each != null && each !== code) {
            names.set(each.toLowerCase(), script);
            languageCodes.set(each.toLowerCase(), code);
          }
      } catch {
        // A code Intl does not know names no language.
      }
    }
  // Names a model answers with that the English display names spell otherwise.
  for (const [alias, code] of Object.entries(LANGUAGE_ALIASES)) {
    const script = scriptOfCode(new Intl.Locale(code).maximize().script ?? "");
    if (script != null) names.set(alias, script);
    languageCodes.set(alias, code);
  }
  languageNames = names;
  return names;
};

/** A name without its "(…)" qualifiers; a scan, so no input can make it slow. */
const withoutParentheses = (name: string): string => {
  let out = "";
  let depth = 0;
  for (const char of name) {
    if (char === "(") depth += 1;
    else if (char === ")" && depth > 0) depth -= 1;
    else if (depth === 0) out += char;
  }
  return out;
};

/**
 * Languages a reader takes for one: Serbian, Croatian, Bosnian and
 * Montenegrin; Malay and Indonesian; Norway's two written standards. A reply
 * in one to a person writing another is not drift.
 */
const LANGUAGE_FAMILY: Record<string, string> = {
  sr: "hr",
  bs: "hr",
  cnr: "hr",
  sh: "hr",
  ms: "id",
  nb: "no",
  nn: "no",
};

const familyOf = (code: string): string => {
  const base = code.trim().toLowerCase().split(/[-_]/)[0] ?? "";
  return LANGUAGE_FAMILY[base] ?? base;
};

/** Whether two language codes ("pt", "pt-BR"; "sr", "hr") name one language to its reader. */
export const sameLanguage = (a: string, b: string): boolean =>
  familyOf(a) === familyOf(b);

/** A language code's English name, as the prompt states it: "vi" is "Vietnamese". */
export const languageNameOfCode = (code: string): string => {
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(code) ?? code;
  } catch {
    return code;
  }
};

/** The code of a language named in English or its own words: "Brazilian Portuguese" is "pt", "Türkçe" is "tr". */
export const languageCodeOfName = (name: string): string | null => {
  namedLanguages();
  const lower = withoutParentheses(name)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return (
    languageCodes.get(lower) ??
    languageCodes.get(lower.split(/\s+/).at(-1) ?? "") ??
    null
  );
};

/** The script a language code ("bn", "pt-BR") is written in; null when unknown. */
export const languageCodeScript = (code: string): Script | null => {
  try {
    return scriptOfCode(new Intl.Locale(code).maximize().script ?? "");
  } catch {
    return null;
  }
};

/** The script a language is written in, from its English name ("Brazilian Portuguese"); null when unknown. */
export const languageScript = (name: string): Script | null => {
  const names = namedLanguages();
  // "Bengali (romanized)" is Bengali.
  const lower = withoutParentheses(name)
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
  return names.get(lower) ?? names.get(lower.split(/\s+/).at(-1) ?? "") ?? null;
};

let namedPattern: RegExp | null = null;
/** The scripts of the languages a text names: "in Arabic", "به فارسی". */
const namesIn = (text: string): string[] => {
  const names = namedLanguages();
  namedPattern ??= new RegExp(
    `(?<![\\p{L}\\p{M}])(${[...names.keys()]
      .sort((a, b) => b.length - a.length)
      .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join("|")})(?![\\p{L}\\p{M}])`,
    "giu"
  );
  return [...text.toLowerCase().matchAll(namedPattern)].map(
    (match) => match[1] ?? ""
  );
};

const scriptsNamedIn = (text: string): Script[] => {
  const names = namedLanguages();
  return namesIn(text).flatMap((name) => {
    const script = names.get(name);
    return script == null ? [] : [script];
  });
};

/**
 * Whether a text names a language in one of the given languages: "tiếng
 * Anh" is English to a Vietnamese writer. A substring, case aside, so a
 * Hungarian "angolul" names "angol".
 */
const namesLanguageIn = (
  text: string,
  code: string,
  languages: readonly string[]
): boolean => {
  const lower = text.toLowerCase();
  for (const language of languages)
    try {
      const name = new Intl.DisplayNames([language], { type: "language" })
        .of(code)
        ?.toLowerCase();
      if (name != null && name !== code && lower.includes(name)) return true;
    } catch {
      // A code Intl does not know names nothing.
    }
  return false;
};

/** The codes of the languages a text names: "translate this into English" names "en". */
const languagesNamedIn = (text: string): string[] =>
  namesIn(text).flatMap((name) => {
    const code = languageCodes.get(name);
    return code == null ? [] : [code];
  });

const textOf = (message: unknown): string => {
  const content = (message as { content?: unknown } | undefined)?.content;
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (block) =>
        block != null &&
        typeof block === "object" &&
        (block as { type?: string }).type === "text"
    )
    .map((block) => String((block as { text?: unknown }).text ?? ""))
    .join("\n");
};

const roleOf = (message: unknown): string | undefined =>
  (message as { role?: unknown } | undefined)?.role as string | undefined;

/** How many earlier messages are remembered. */
const RECENT_TURNS = 5;

/**
 * The person's own words (user-text.ts `ownWords`) over the last few turns of
 * one session. A run's `agent_end` carries only that run's messages, so the
 * engine keeps these to judge a reply by the person rather than by one "ok".
 * Seeded from the transcript when a session is resumed; holds words only.
 */
export class RecentOwnWords {
  private earlier: string[] = [];
  private now = "";
  private seen = 0;

  /** A new turn, with its own words ("" when the app started it). */
  beginTurn(words: string): void {
    if (this.now.trim().length > 0) this.remember(this.now);
    this.now = words;
    this.seen += scriptCounts(words).letters;
  }

  /** Words steered into the running turn. */
  add(words: string): void {
    if (words.trim().length === 0) return;
    this.now = this.now.length > 0 ? `${this.now}\n\n${words}` : words;
    this.seen += scriptCounts(words).letters;
  }

  /** Letters of theirs read so far: how far their words have moved on. */
  get lettersSeen(): number {
    return this.seen;
  }

  /** Earlier turns then this one, as one text. */
  get window(): string {
    return [...this.earlier, this.now].filter((w) => w.length > 0).join("\n\n");
  }

  /** A resumed session's earlier user turns, each read with `own`. */
  seed(messages: readonly unknown[], own: (text: string) => string): void {
    for (const message of messages)
      if (roleOf(message) === "user") {
        const words = own(textOf(message));
        if (words.trim().length > 0) this.remember(words);
        this.seen += scriptCounts(words).letters;
      }
  }

  clear(): void {
    this.earlier = [];
    this.now = "";
    this.seen = 0;
  }

  get turn(): string {
    return this.now;
  }

  get recent(): readonly string[] {
    return this.earlier;
  }

  private remember(words: string): void {
    this.earlier.push(words);
    if (this.earlier.length > RECENT_TURNS) this.earlier.shift();
  }
}

/** The person's language as saved from their own words or their choice. */
export interface KnownLanguage {
  script: Script;
  /** They asked for it (`set_user_language`), rather than it being learnt. */
  chosen: boolean;
}

/** What a reply is judged against: the person, not the run. */
export interface ReplyLanguageContext {
  /** This turn's own words; "" for a turn the app started. */
  turn: string;
  /** Earlier turns' own words, oldest first. */
  recent: readonly string[];
  /** Their saved language: a reply in its script is theirs, typed in Latin or not. */
  known?: KnownLanguage | null;
  /**
   * The language a text is in, read on the device (language-id.ts
   * `identifyLanguage`), or null when it cannot tell from so few letters.
   * Without it a reply is judged on its script only.
   */
  identify?: (text: string, minLetters?: number) => string | null;
  /** The code of their saved language, chosen or learnt from their words; never the app's. */
  savedLanguage?: string | null;
  /**
   * The app started this turn for the person (a first run, a routine, a
   * connector that came up): there is nothing of theirs to read, so the
   * reply is judged against their saved language.
   */
  appTurn?: boolean;
}

export interface ReplyLanguageMismatch {
  /** The script the person writes in. */
  expected: Script;
  /** The script the reply came back in. */
  got: Script;
  /**
   * The person typed Latin and the reply is in another script: right if
   * their words are that language romanized (Hinglish answered in
   * Devanagari), so only a check of their language (`WordsLanguage`) decides.
   */
  romanized?: true;
  /** One script, another language: codes of what they write and what came back ("vi", "en"). */
  language?: { expected: string; got: string };
}

/** Below this many letters a reply is judged on its script only, never its language. */
const REPLY_LANGUAGE_LETTERS = 40;

/** Scripts the person uses or asked for, and the one they write in most. */
const allowedScripts = ({
  turn,
  recent,
  known,
}: ReplyLanguageContext): {
  allowed: Set<Script>;
  expected: Script;
  latinTurn: boolean;
} | null => {
  const now = scriptCounts(turn);
  if (now.letters === 0) return null;
  const nonLatinNow = now.letters - (now.counts.get("latin") ?? 0);
  const earlier = recent.map(scriptCounts);
  const earlierLetters = earlier.reduce((sum, each) => sum + each.letters, 0);
  // Too little to know the person by: "ok" opening a session. A few letters
  // of another script are plain enough.
  if (
    now.letters < MIN_LETTERS &&
    earlierLetters < MIN_LETTERS &&
    nonLatinNow < USED_LETTERS
  )
    return null;
  const allowed = new Set<Script>();
  const weight = new Map<Script, number>();
  for (const [script, count] of now.counts) {
    if (count >= USED_LETTERS || count / now.letters >= USED_SHARE)
      allowed.add(script);
    weight.set(script, (weight.get(script) ?? 0) + count);
  }
  // Earlier Latin only backs a short message ("ok", "Спасибо"): a long one says it all.
  const latinFromEarlier = now.letters < MIN_LETTERS;
  for (const { counts, letters } of earlier) {
    if (letters < USED_LETTERS) continue;
    for (const [script, count] of counts) {
      if (script === "latin" && !latinFromEarlier) continue;
      if (count / letters < RECENT_SHARE) continue;
      allowed.add(script);
      weight.set(script, (weight.get(script) ?? 0) + count);
    }
  }
  for (const script of scriptsNamedIn([...recent, turn].join("\n")))
    allowed.add(script);
  // A saved language backs its script for words typed in Latin; a learnt
  // English never excuses a Latin reply to words in another script.
  if (known != null && (known.chosen || known.script !== "latin"))
    allowed.add(known.script);
  const heaviest = [...weight].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "latin";
  return {
    allowed,
    expected: known?.chosen === true ? known.script : heaviest,
    latinTurn: nonLatinNow < USED_LETTERS,
  };
};

/**
 * A reply in the person's script but another language: English to someone
 * writing Vietnamese, Hungarian to someone writing English. Judged only on
 * what can be read with confidence: their words this turn (or, for a turn
 * the app started, their saved language) and a reply long enough to read.
 * Any language they used in recent turns, named, or saved passes, and a
 * language they chose is the only one that does. Across scripts is the
 * script check's, romanized typing included.
 */
const languageMismatch = (
  reply: string,
  context: ReplyLanguageContext
): ReplyLanguageMismatch | null => {
  const { identify, turn, recent, known } = context;
  if (identify == null) return null;
  const saved = context.savedLanguage ?? null;
  const chosen = known?.chosen === true && saved != null;
  const now = identify(turn);
  const appTurn = context.appTurn === true && now == null;
  const expected = chosen ? saved : (now ?? (appTurn ? saved : null));
  if (expected == null) return null;
  const got = identify(reply, REPLY_LANGUAGE_LETTERS);
  if (got == null) return null;
  const script = dominantScript(reply);
  const theirs =
    now != null && !chosen
      ? dominantScript(turn)
      : languageCodeScript(expected);
  if (script == null || script !== theirs) return null;
  const named = languagesNamedIn([...recent, turn].join("\n"));
  const allowed = chosen
    ? [expected, ...named]
    : [expected, saved, ...recent.map((words) => identify(words)), ...named];
  if (allowed.some((code) => code != null && sameLanguage(code, got)))
    return null;
  // Asked for in their own words: "dịch sang tiếng Anh".
  const theirLanguages = allowed.filter((code): code is string => code != null);
  if (namesLanguageIn([...recent, turn].join("\n"), got, theirLanguages))
    return null;
  return { expected: script, got: script, language: { expected, got } };
};

/** The last assistant text after the run's last user message with enough letters to judge; null without one. */
const lastReplyText = (messages: readonly unknown[]): string | null => {
  for (let index = messages.length - 1; index >= 0; index--) {
    const role = roleOf(messages[index]);
    if (role === "user") return null;
    if (role !== "assistant") continue;
    const text = textOf(messages[index]);
    if (scriptCounts(text).letters >= MIN_LETTERS) return text;
  }
  return null;
};

/**
 * Whether one text written to the person is in a script or language they
 * neither write in nor asked for. Used on the reply a turn ends with, and on
 * the progress notes written between tool calls, which the person reads too.
 */
export const textLanguageMismatch = (
  text: string,
  context: ReplyLanguageContext
): ReplyLanguageMismatch | null => {
  const { known } = context;
  const person = allowedScripts(context);
  if (person != null) {
    const { allowed, expected, latinTurn } = person;
    const reply = scriptCounts(text);
    const got = dominantOf(reply);
    // Latin words may be the reply's language romanized; never Han (a known
    // model drift) or against a language they chose.
    if (got != null && !allowed.has(got))
      return latinTurn &&
        got !== "latin" &&
        got !== "cjk" &&
        known?.chosen !== true
        ? { expected, got, romanized: true }
        : { expected, got };
    const han = reply.counts.get("cjk") ?? 0;
    if (
      !allowed.has("cjk") &&
      han >= MIN_LETTERS &&
      han / reply.letters >= FOREIGN_SHARE
    )
      return { expected, got: "cjk" };
  }
  return languageMismatch(text, context);
};

/**
 * Whether the turn ended in a script or language the person neither writes
 * in nor asked for. Only the LAST assistant text with enough to judge
 * counts: the drift starts after a run of tool results, and the whole reply
 * would let the paragraphs ahead of it outvote the wrong-language tail the
 * user is left reading. `messages` is the run's, as `agent_end` gives them;
 * the person comes from `context`.
 */
export const replyLanguageMismatch = (
  messages: readonly unknown[],
  context: ReplyLanguageContext
): ReplyLanguageMismatch | null => {
  if (!messages.some((message) => roleOf(message) === "user")) return null;
  const reply = lastReplyText(messages);
  return reply == null ? null : textLanguageMismatch(reply, context);
};

const SCRIPT_NAMES: Record<Script, string> = {
  latin: "the Latin alphabet",
  cjk: "Chinese, Japanese or Korean characters",
  cyrillic: "the Cyrillic alphabet",
  arabic: "the Arabic script",
  hebrew: "the Hebrew alphabet",
  greek: "the Greek alphabet",
  armenian: "the Armenian alphabet",
  georgian: "the Georgian script",
  ethiopic: "the Ethiopic script",
  devanagari: "Devanagari",
  bengali: "the Bengali script",
  gurmukhi: "Gurmukhi",
  gujarati: "the Gujarati script",
  oriya: "the Odia script",
  tamil: "the Tamil script",
  telugu: "the Telugu script",
  kannada: "the Kannada script",
  malayalam: "the Malayalam script",
  sinhala: "the Sinhala script",
  thai: "the Thai script",
  lao: "the Lao script",
  khmer: "the Khmer script",
  myanmar: "the Myanmar script",
};

/** The language replies are in when the message gives none; see user-language.ts. */
export interface ReplyLanguage {
  /** English name: "Turkish", "Brazilian Portuguese". */
  name: string;
  /** The user asked for it (`set_user_language`): it outranks their message. */
  chosen: boolean;
}

/** A Chinese, Japanese or Korean reply may carry Han characters. */
const CJK_LANGUAGE = /chinese|japanese|korean|cantonese|mandarin/i;

/**
 * The reply-language rule, one paragraph for every chat. Depends on nothing
 * but `language` and who is writing, so the prompt stays byte-identical per
 * turn. The fallback is named outright and the app's own notes are called
 * out: a first-run or routine note is text from the app, and a model reads
 * it as the latest message otherwise. In a sender chat the person writing is
 * someone else, and the user's language is only the fallback.
 */
export const replyLanguageLine = (
  { name, chosen }: ReplyLanguage,
  senderChat = false
): string => {
  const article = /^[aeiou]/i.test(name) ? "an" : "a";
  const noHan = CJK_LANGUAGE.test(name)
    ? ""
    : ` (no Chinese characters in ${article} ${name} reply)`;
  const request = (who: string): string =>
    `When ${who} asks for a reply language ("answer in English", "reply in Turkish", in whatever ` +
    "language they ask it), that request wins over all of this: switch at once, and keep to it from " +
    "then on unless they asked for that one reply only.";
  const which = senderChat
    ? "The person writing to you here is not the user. Reply in the language of their latest message; " +
      `when it has no words to go by (a greeting like "ok", a link), reply in ${name}, the user's language. ` +
      "The app's own notes (an [auto-reply] note, a system reminder) are not their words. " +
      request("the person writing")
    : chosen
      ? `The user chose ${name} for every reply: reply in ${name}, whatever language their message ` +
        `or the app's own notes are in. ${request("the user")}`
      : `The user's language is ${name}. Reply in the language of the user's latest message; ` +
        `when it has no words to go by (a greeting like "ok", a link), reply in ${name}. The app's ` +
        "own messages (a [first run] or [routine] note, a system reminder) are not the user's words: " +
        `answer them in ${name}. ${request("the user")}`;
  return (
    `${which} Write the whole reply in that one language and its script: never switch partway, ` +
    `and never mix in words or characters from another language${noHan}, whatever language ` +
    `the tool results, documents or messages you read were in. Names, code and quoted text stay as they are.`
  );
};

/** The rule as a system-prompt block, placed last in every engine. */
export const replyLanguagePrompt = (
  language: ReplyLanguage,
  senderChat = false
): string =>
  ["## Reply language", "", replyLanguageLine(language, senderChat)].join("\n");

/** What was written and what they write, in the words the model is told. */
const mismatchNames = (
  mismatch: ReplyLanguageMismatch
): { got: string; expected: string } =>
  mismatch.language != null
    ? {
        got: languageNameOfCode(mismatch.language.got),
        expected: languageNameOfCode(mismatch.language.expected),
      }
    : {
        got: SCRIPT_NAMES[mismatch.got],
        expected: SCRIPT_NAMES[mismatch.expected],
      };

/**
 * What the model is told when its reply came back in the wrong script or
 * language. In a sender chat only the <reply> block is delivered, so the
 * rewrite keeps it.
 */
export const replyLanguageRepairPrompt = (
  mismatch: ReplyLanguageMismatch,
  senderChat = false
): string => {
  const { got, expected } = mismatchNames(mismatch);
  return (
    `Your last reply was written in ${got}, but the person you are answering writes in ${expected}. Write that reply again now, in full, in their language, and keep answering in it.` +
    (senderChat ? " Put the words to send inside <reply></reply>." : "")
  );
};

/**
 * What the model is told when a note it wrote between tool calls drifted,
 * or null when the note is in the person's language. The person reads those
 * notes too and the work goes on, so nothing is rewritten. A romanized
 * candidate needs the model's reading of their words; the turn's end has it.
 */
export const progressLanguageSteer = (
  note: string,
  context: ReplyLanguageContext
): string | null => {
  const mismatch = textLanguageMismatch(note, context);
  if (mismatch == null || mismatch.romanized === true) return null;
  const { got, expected } = mismatchNames(mismatch);
  return `You just wrote to the person in ${got}, but they write in ${expected}. Write everything from here on in their language, progress notes included, and finish the work as planned.`;
};
