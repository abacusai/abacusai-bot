/**
 * The language a reply is written in, judged by script. A model can drift into
 * another language after a run of tool results; the prompt asks it not to, and
 * this check lets the turn continue with a repair when it does anyway. Script,
 * not language: telling Latin from Han needs only a code-point range, and the
 * drift that matters is always across scripts. Code and the app's reminders
 * are left out of the count.
 */

export type Script =
  | "latin"
  | "cjk"
  | "cyrillic"
  | "arabic"
  | "devanagari"
  | "hebrew"
  | "thai"
  | "greek";

const SCRIPT_PATTERNS: ReadonlyArray<readonly [Script, RegExp]> = [
  ["latin", /\p{Script=Latin}/u],
  [
    "cjk",
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u,
  ],
  ["cyrillic", /\p{Script=Cyrillic}/u],
  ["arabic", /\p{Script=Arabic}/u],
  ["devanagari", /\p{Script=Devanagari}/u],
  ["hebrew", /\p{Script=Hebrew}/u],
  ["thai", /\p{Script=Thai}/u],
  ["greek", /\p{Script=Greek}/u],
];

/** Below this many letters a text says nothing about its language. */
const MIN_LETTERS = 20;
/** The user's side is judged on whatever letters it has: "ok" is a language. */
const MIN_USER_LETTERS = 1;
/** A script has to carry this share of the letters to be "the" script. */
const DOMINANT_SHARE = 0.6;

/** Fenced and inline code, and the app's own reminder blocks, stripped. */
const withoutCodeAndReminders = (text: string): string =>
  text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<system_reminder>[\s\S]*?<\/system_reminder>/g, " ");

interface ScriptTally {
  counts: Map<Script, number>;
  letters: number;
}

/** Letters per script, prose only. */
const scriptCounts = (text: string): ScriptTally => {
  const counts = new Map<Script, number>();
  let letters = 0;
  for (const char of withoutCodeAndReminders(text)) {
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

const dominantOf = (
  { counts, letters }: ScriptTally,
  minLetters: number
): Script | null => {
  if (letters < minLetters) return null;
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
  dominantOf(scriptCounts(text), MIN_LETTERS);

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

/**
 * The user's script, read off their turns newest first until there is enough
 * text to judge. A guard that gives up on a short question is off for most of
 * them, so earlier turns settle it; a lone short first message is judged on
 * whatever letters it has.
 */
export const userScript = (messages: readonly unknown[]): Script | null => {
  const total: ScriptTally = { counts: new Map(), letters: 0 };
  for (let index = messages.length - 1; index >= 0; index--) {
    if (roleOf(messages[index]) !== "user") continue;
    const { counts, letters } = scriptCounts(textOf(messages[index]));
    total.letters += letters;
    for (const [script, count] of counts) {
      total.counts.set(script, (total.counts.get(script) ?? 0) + count);
    }
    if (total.letters >= MIN_LETTERS) break;
  }
  return dominantOf(total, MIN_USER_LETTERS);
};

export interface ReplyLanguageMismatch {
  /** The script the user wrote in. */
  expected: Script;
  /** The script the reply came back in. */
  got: Script;
}

/**
 * Whether the turn ended in a different script from the message it answers.
 * Only the LAST assistant text with enough to judge counts: the drift starts
 * after a run of tool results, and the whole reply would let the paragraphs
 * ahead of it outvote the wrong-script tail the user is left reading.
 */
export const replyLanguageMismatch = (
  messages: readonly unknown[]
): ReplyLanguageMismatch | null => {
  let lastUser = -1;
  for (let index = messages.length - 1; index >= 0; index--) {
    if (roleOf(messages[index]) === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return null;
  const expected = userScript(messages);
  if (expected == null) return null;
  for (let index = messages.length - 1; index > lastUser; index--) {
    if (roleOf(messages[index]) !== "assistant") continue;
    const got = dominantScript(textOf(messages[index]));
    if (got == null) continue;
    return got === expected ? null : { expected, got };
  }
  return null;
};

const SCRIPT_NAMES: Record<Script, string> = {
  latin: "the Latin alphabet",
  cjk: "Chinese, Japanese or Korean characters",
  cyrillic: "the Cyrillic alphabet",
  arabic: "the Arabic script",
  devanagari: "Devanagari",
  hebrew: "the Hebrew alphabet",
  thai: "the Thai script",
  greek: "the Greek alphabet",
};

/** The standing rule, for the system prompt. */
export const REPLY_LANGUAGE_PROMPT = [
  "## Reply language",
  "",
  "Always answer in the language the user writes in, and keep to it for the",
  "whole reply. Never switch language partway through an answer, and never",
  "answer in a language the user has not used — whatever language the tool",
  "results, documents or messages you read were in.",
].join("\n");

/** What the model is told when its reply came back in the wrong script. */
export const replyLanguageRepairPrompt = (
  mismatch: ReplyLanguageMismatch
): string =>
  `Your last reply was written in ${SCRIPT_NAMES[mismatch.got]}, but the user writes in ${SCRIPT_NAMES[mismatch.expected]}. Write that reply again now, in full, in the user's language — and keep answering in it.`;
