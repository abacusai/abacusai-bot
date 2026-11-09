/**
 * The language replies are in, one precedence for every engine:
 *
 * 1. the language the user chose (`set_user_language`);
 * 2. the language of their current message, which the prompt line leaves to
 *    the model, so nothing per turn reaches the prompt;
 * 3. the language detected once from their first messages;
 * 4. the app's language (the UI pick, else the OS's), ABACUSAI_BOT_LOCALE;
 * 5. English.
 *
 * In a bot's chat with a remote sender the sender is someone else, so their
 * message wins and the user's choice is only the fallback. The app never
 * picks Hindi on its own: a Hindi device language reads as English, while a
 * user who writes or asks for Hindi gets Hindi. The resolved language
 * closes every system prompt, so bots, routines and setup runs that have no
 * message to copy still answer in it; engines rebuild the prompt only when it
 * changes, which is at most once per account at a reload.
 */
import fs from "fs";
import path from "path";

import { abacusV1BaseUrl } from "./abacus-endpoint.js";
import { writeFileAtomicSync } from "./atomic-file.js";
import { abacusBotDir } from "./config.js";
import {
  type KnownLanguage,
  languageScript,
  type RecentOwnWords,
  type ReplyLanguage,
  replyLanguagePrompt,
  type Script,
} from "./reply-language.js";

/** The cheap model the free plan already runs on. */
export const USER_LANGUAGE_DETECT_MODEL = "deepseek-ai/DeepSeek-V4.1-Flash";
/** Messages tried before giving up on detection: "hi" or a link names no language. */
export const USER_LANGUAGE_DETECT_ATTEMPTS = 3;
const DETECT_TIMEOUT_MS = 15_000;
const DETECT_MAX_CHARS = 1_000;
const NAME_MAX_CHARS = 40;
const ENGLISH = "English";

export interface UserLanguage {
  /** English name of the language, as the prompt states it: "Turkish". */
  name: string;
  source: "detected" | "user";
}

interface StoredUserLanguage {
  language?: UserLanguage;
  /** Detection calls made while nothing is set. */
  attempts?: number;
  /** STORE_VERSION once written by detection that reads only the user's own words. */
  version?: number;
}

/**
 * Before version 2, detection also read the app's notes (a first run's
 * reminder), so a detected language or a spent attempt count from then is
 * forgotten once and learnt again from what the user types. A language the
 * user chose stays.
 */
const STORE_VERSION = 2;

export function userLanguagePath(): string {
  return path.join(abacusBotDir(), "user-language.json");
}

const readStored = (): StoredUserLanguage => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(userLanguagePath(), "utf8")
    ) as StoredUserLanguage;
    if (parsed == null || typeof parsed !== "object") return {};
    if (parsed.version === STORE_VERSION || parsed.language?.source === "user")
      return parsed;
    return {};
  } catch {
    // Missing or unreadable must never stop a session starting.
    return {};
  }
};

const writeStored = (stored: StoredUserLanguage): void => {
  writeFileAtomicSync(
    userLanguagePath(),
    JSON.stringify({ ...stored, version: STORE_VERSION })
  );
};

/** A language name as the prompt may state it, or null. */
const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX_CHARS) return null;
  // A name, not an instruction smuggled in as one.
  if (!/^\p{L}[\p{L}\p{M} ()'-]*$/u.test(name)) return null;
  return name.charAt(0).toUpperCase() + name.slice(1);
};

export function readUserLanguage(): UserLanguage | null {
  const language = readStored().language;
  const name = cleanName(language?.name);
  if (name == null) return null;
  return { name, source: language?.source === "user" ? "user" : "detected" };
}

/** Saves a language; false when the name is not one. */
export function writeUserLanguage(
  name: string,
  source: UserLanguage["source"]
): boolean {
  const clean = cleanName(name);
  if (clean == null) return false;
  writeStored({ language: { name: clean, source } });
  return true;
}

/**
 * A BCP 47 tag's language in English, as the prompt states it: "pt-BR" is
 * "Brazilian Portuguese", "tr-TR" is "Turkish" (a region only when the
 * language has a name for it). Chinese is named by the script its region
 * reads: "zh-HK" is "Traditional Chinese", so a reply never lands in the
 * wrong one. Null for a tag that names no language.
 */
function localeLanguageName(tag: string): string | null {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const locale = new Intl.Locale(tag.trim().replace(/_/g, "-"));
    // A device set to Hindi never makes Hindi the reply language.
    if (locale.language === "hi") return ENGLISH;
    const full = names.of(
      locale.language === "zh"
        ? `zh-${locale.maximize().script}`
        : locale.toString()
    );
    const base = names.of(locale.language);
    const name = full != null && !full.includes("(") ? full : base;
    if (name == null || name.toLowerCase() === tag.trim().toLowerCase())
      return null;
    return cleanName(name);
  } catch {
    return null;
  }
}

/** Whether this is a bot's chat with a remote sender, as the desktop that spawned it says. */
export const isSenderChat = (): boolean =>
  (process.env.ABACUSAI_BOT_SENDER_CHAT ?? "").trim() === "1";

/** The precedence above, from its inputs; see the module comment. */
export function resolveReplyLanguage(
  saved: UserLanguage | null,
  appLocale: string | null | undefined,
  senderChat = false
): ReplyLanguage {
  const savedName = saved == null ? null : cleanName(saved.name);
  if (savedName != null)
    return { name: savedName, chosen: saved?.source === "user" && !senderChat };
  const app = appLocale == null ? null : localeLanguageName(appLocale);
  return { name: app ?? ENGLISH, chosen: false };
}

/** This session's reply language, by the precedence above. */
export function accountReplyLanguage(): ReplyLanguage {
  return resolveReplyLanguage(
    readUserLanguage(),
    process.env.ABACUSAI_BOT_LOCALE,
    isSenderChat()
  );
}

/** The reply-language block this session's prompt closes with. */
export function accountReplyLanguagePrompt(): string {
  return replyLanguagePrompt(accountReplyLanguage(), isSenderChat());
}

/**
 * The user's saved language as a script, which a reply may always be in: a
 * user who types Bengali or Hindi in Latin letters is answered in its own
 * script. Learnt from their words or chosen, never the app's language; none
 * in a sender's chat, where the person writing is someone else.
 */
export function knownReplyLanguage(): KnownLanguage | null {
  const saved = readUserLanguage();
  if (saved == null || isSenderChat()) return null;
  const script = languageScript(saved.name);
  return script == null ? null : { script, chosen: saved.source === "user" };
}

const detectPrompt = (text: string): string =>
  [
    "Which language is the following message written in? Answer with only the language's",
    'English name, such as "Turkish" or "English". If the message is too short or has no',
    'words that name a language (a greeting, a link, code, numbers), answer "unknown".',
    'Chinese is "Simplified Chinese" or "Traditional Chinese", by its characters.',
    "",
    "Message:",
    text.slice(0, DETECT_MAX_CHARS),
  ].join("\n");

/**
 * The language a message is written in, from one small model call, or null
 * when the model cannot tell or the call fails. Never throws.
 */
export async function detectMessageLanguage(
  text: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = DETECT_TIMEOUT_MS
): Promise<string | null> {
  try {
    const response = await fetchImpl(`${abacusV1BaseUrl()}/chat/completions`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: USER_LANGUAGE_DETECT_MODEL,
        messages: [{ role: "user", content: detectPrompt(text) }],
        max_tokens: 10,
        temperature: 0,
      }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const answer = body.choices?.[0]?.message?.content;
    const name = cleanName(
      typeof answer === "string" ? answer.replace(/[."]/g, "") : null
    );
    return name == null || name.toLowerCase() === "unknown" ? null : name;
  } catch {
    return null;
  }
}

/** A turn's end waits on this check, so it gives up sooner than detection. */
const WORDS_CHECK_TIMEOUT_MS = 5_000;
/** Letters of new words after which their language is asked again. */
const WORDS_CHECK_REFRESH_LETTERS = 300;

/**
 * The language a session's person writes in, asked of the detection model
 * only when the reply-language guard has a romanized candidate (Latin words,
 * a reply in another script), and kept until their words move on. One per
 * session, so one per contact in sender chats.
 */
export class WordsLanguage {
  private known: { name: string; at: number } | null = null;

  constructor(
    private readonly detect: (text: string) => Promise<string | null> = (
      text
    ) =>
      detectMessageLanguage(
        text,
        (process.env.ABACUS_API_KEY ?? "").trim(),
        fetch,
        WORDS_CHECK_TIMEOUT_MS
      )
  ) {}

  /**
   * Whether their recent words are the language `script` writes, typed in
   * Latin. No answer (no key, a failed call, "unknown") reads as yes: the
   * reply is left alone rather than rewritten on a guess.
   */
  async writesIn(script: Script, words: RecentOwnWords): Promise<boolean> {
    if (
      this.known == null ||
      words.lettersSeen - this.known.at >= WORDS_CHECK_REFRESH_LETTERS
    ) {
      const name = await this.detect(words.window.slice(-DETECT_MAX_CHARS));
      if (name == null) return true;
      this.known = { name, at: words.lettersSeen };
    }
    return languageScript(this.known.name) === script;
  }

  clear(): void {
    this.known = null;
  }
}

let detecting = false;

/**
 * Detects and saves the user's language from their own words (user-text.ts
 * `ownWords`: "" for a first run or any turn the app wrote), while none is
 * saved and attempts remain. Runs in the background; never throws.
 */
export async function learnUserLanguage(
  text: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  if (detecting || text.trim().length === 0 || apiKey.length === 0) return;
  const stored = readStored();
  if (cleanName(stored.language?.name) != null) return;
  const attempts = stored.attempts ?? 0;
  if (attempts >= USER_LANGUAGE_DETECT_ATTEMPTS) return;
  detecting = true;
  try {
    const name = await detectMessageLanguage(text, apiKey, fetchImpl);
    // The user may have set one while the call ran: theirs wins.
    if (readUserLanguage() != null) return;
    if (name != null && writeUserLanguage(name, "detected")) return;
    writeStored({ attempts: attempts + 1 });
  } catch {
    // Detection is best effort: a failed write leaves it to the next message.
  } finally {
    detecting = false;
  }
}

/** `set_user_language`: the user asked to be answered in another language from now on. */
export function buildSetUserLanguageTool() {
  return {
    name: "set_user_language",
    label: "set_user_language",
    description: [
      "Save the language the user wants every reply in, for this and all future",
      "conversations, bots and scheduled runs. Call it when the user asks to be answered",
      'in a language from now on, including a bare language name such as "türkçe" or',
      '"in English please", whatever language they ask in, and when they ask to go back',
      'to an earlier one ("go back to Turkish"). Do not call it for a one-off request',
      "(say this in English, translate this, write this email in German). Then answer in",
      "that language.",
    ].join(" "),
    parameters: {
      type: "object",
      properties: {
        language: {
          type: "string",
          description: 'The language\'s English name, e.g. "Turkish".',
        },
      },
      required: ["language"],
      additionalProperties: false,
    },
    execute: async (
      _toolCallId: string,
      params: Record<string, unknown>
    ): Promise<{
      content: Array<{ type: "text"; text: string }>;
      details: null;
      isError?: boolean;
    }> => {
      const name = cleanName(params.language);
      if (name == null || !writeUserLanguage(name, "user"))
        return {
          content: [
            {
              type: "text",
              text: 'Not saved: give the language\'s English name, e.g. "Turkish".',
            },
          ],
          details: null,
          isError: true,
        };
      return {
        content: [
          {
            type: "text",
            text: `Saved: replies are now in ${name}, in every conversation. Answer in ${name}.`,
          },
        ],
        details: null,
      };
    },
  };
}
