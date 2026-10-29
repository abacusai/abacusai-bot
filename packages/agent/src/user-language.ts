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
 * message wins and the user's choice is only the fallback. Hindi is never a
 * reply language: from any source it reads as English. The resolved language
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
  type ReplyLanguage,
  replyLanguagePrompt,
  withoutAppNotes,
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
}

export function userLanguagePath(): string {
  return path.join(abacusBotDir(), "user-language.json");
}

const readStored = (): StoredUserLanguage => {
  try {
    const parsed = JSON.parse(
      fs.readFileSync(userLanguagePath(), "utf8")
    ) as StoredUserLanguage;
    return parsed != null && typeof parsed === "object" ? parsed : {};
  } catch {
    // Missing or unreadable must never stop a session starting.
    return {};
  }
};

const writeStored = (stored: StoredUserLanguage): void => {
  writeFileAtomicSync(userLanguagePath(), JSON.stringify(stored));
};

/** A language name as the prompt may state it, or null. */
const cleanName = (raw: unknown): string | null => {
  if (typeof raw !== "string") return null;
  const name = raw.trim().replace(/\s+/g, " ");
  if (name.length === 0 || name.length > NAME_MAX_CHARS) return null;
  // A name, not an instruction smuggled in as one.
  if (!/^\p{L}[\p{L}\p{M} ()'-]*$/u.test(name)) return null;
  // Hindi is never a reply language; Hinglish reads as English too.
  if (/^(hindi|hinglish)\b/i.test(name)) return ENGLISH;
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
 * language has a name for it). Null for a tag that names no language.
 */
function localeLanguageName(tag: string): string | null {
  try {
    const names = new Intl.DisplayNames(["en"], { type: "language" });
    const full = names.of(tag.trim().replace(/_/g, "-"));
    const base = names.of(
      new Intl.Locale(tag.trim().replace(/_/g, "-")).language
    );
    const name = full != null && !full.includes("(") ? full : base;
    if (name == null || name.toLowerCase() === tag.trim().toLowerCase())
      return null;
    return cleanName(name);
  } catch {
    return null;
  }
}

/** Whether this is a bot's chat with a remote sender, as the desktop that spawned it says. */
const isSenderChat = (): boolean =>
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

/** The reply-language block this session's prompt closes with. */
export function accountReplyLanguagePrompt(): string {
  return replyLanguagePrompt(
    resolveReplyLanguage(
      readUserLanguage(),
      process.env.ABACUSAI_BOT_LOCALE,
      isSenderChat()
    )
  );
}

const detectPrompt = (text: string): string =>
  [
    "Which language is the following message written in? Answer with only the language's",
    'English name, such as "Turkish" or "English". If the message is too short or has no',
    'words that name a language (a greeting, a link, code, numbers), answer "unknown".',
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
  fetchImpl: typeof fetch = fetch
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
      signal: AbortSignal.timeout(DETECT_TIMEOUT_MS),
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

let detecting = false;

/**
 * Detects and saves the user's language from a message they wrote, while none
 * is saved and attempts remain. Runs in the background; never throws.
 */
export async function learnUserLanguage(
  message: string,
  apiKey: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  // The app's own tagged notes ("[first run] ...") are English and not theirs.
  const text = withoutAppNotes(message);
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
