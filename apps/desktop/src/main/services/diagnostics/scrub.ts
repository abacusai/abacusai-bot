/**
 * Take the secrets and the user's name out of anything on its way to disk.
 * Omission cannot cover a key that reached a console.error or a home
 * directory in every path; this runs over whole texts so a new stream is
 * covered by default. Shared by log-dump.ts and log-store.ts; `scrubKeys` and
 * `scrubValue` are what the transcript, diagnostics and feedback uploads use.
 */
import os from "node:os";
import path from "node:path";

const MASKED_KEY = "<redacted-key>";
const MASKED_VALUE = "<redacted>";

/** Shorter than this under a secret's key is a flag or a label. */
const MIN_SECRET_LENGTH = 6;

/** Two words under a secret's key are a scheme and its credential. */
const MIN_SENTENCE_WORDS = 3;

/** Self-identifying shapes: the prefix says what it is. */
const KEY_SHAPES: readonly RegExp[] = [
  /\b[rs]k_(?:live|test)_[A-Za-z0-9]{16,}/g, // Stripe
  /\bs2_[A-Za-z0-9]{16,}/g, // Abacus
  /\bgh[pousr]_[A-Za-z0-9]{16,}/g,
  /gh[pousr]_[A-Za-z0-9]{36,}/g, // at full length, also run on from a word
  /\bgithub_pat_[A-Za-z0-9_]{22,}/g,
  /\bglpat-[A-Za-z0-9_-]{20,}/g,
  /\bAIza[A-Za-z0-9_-]{20,}/g,
  /AIza[A-Za-z0-9_-]{35}/g, // the same
  /\bAQ\.[A-Za-z0-9_-]{40,}/g, // Google's newer API key format
  /\bya29\.[A-Za-z0-9_-]{20,}/g,
  /\bGOCSPX-[A-Za-z0-9_-]{20,}/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
  /\bxox[abposre]-[A-Za-z0-9-]{10,}/g,
  /\bxapp-[A-Za-z0-9-]{20,}/g,
  /\b[MNO][A-Za-z0-9_-]{23,27}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // Discord bot token
  /\bmfa\.[A-Za-z0-9_-]{60,}/g, // Discord user token
  /\b\d{8,12}:AA[A-Za-z0-9_-]{30,}/g, // Telegram bot token
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
  /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----|$)/g,
];

/** The end of a key whose start was in earlier text: whole keys are gone by now. */
const PRIVATE_KEY_END = /^[\s\S]*-----END [A-Z0-9 ]{0,40}PRIVATE KEY-----/;

/** A URL that is itself the credential: its last part is the secret. */
const WEBHOOK =
  /\b((?:discord(?:app)?\.com\/api\/webhooks\/\d+\/|hooks\.slack\.com\/services\/[A-Za-z0-9]+\/[A-Za-z0-9]+\/))[A-Za-z0-9_-]{16,}/g;

/**
 * sk- is also how plenty of ordinary names start (sk-learn,
 * sk-button-primary), so a part of it must look random.
 */
const SK_KEY = /(?:sk|rk)-[A-Za-z0-9_-]{12,}/g;
const SK_KEY_MIN_PART_LENGTH = 12;

/** Run on from a word it is `task-…`: only a long, mixed-case part counts. */
const SK_KEY_RUN_ON_MIN_PART_LENGTH = 32;

/**
 * Text inside a JSON string spells a newline as backslash-n, whose n would
 * join the key after it into one word. This goes between them while the
 * rules run; a private-use character, so no text has it.
 */
const ESCAPE_BREAK = "\uE000";
const ESCAPED_WHITESPACE = /(\\[nrt])(?=[A-Za-z0-9])/g;

/** Not `Bearer authentication`: a token has a digit, a word does not. */
const BEARER = /(\bbearer\s+)([A-Za-z0-9._~+/-]{12,}=*)/gi;
const AUTH_HEADER =
  /(\bauthorization\\?["']?\s*[:=]\s*\\?["']?\s*(?:basic|token)\s+)([A-Za-z0-9._~+/=-]{8,})/gi;

/** user:password@host in any scheme: database and broker strings. */
const URL_CREDENTIAL =
  /\b([A-Za-z][A-Za-z0-9+.-]{1,31}:\/\/[^\s:/@]*:)([^\s@/<>{}]{3,})(@)/g;

/** The last word of a name is enough: client_secret, DISCORD_BOT_TOKEN. */
const SECRET_NAME =
  "secret|token|password|passwd|pwd|authorization|credentials?|cookie|apikey|(?:api|access|private)[ _-]?key";

/**
 * Backslashes because a tool's arguments are often JSON inside a JSON string.
 * Anchored on the name: this runs over whole segments of text.
 */
const NAMED_SECRET = new RegExp(
  `((?:${SECRET_NAME})(?:\\\\?["'])?\\s{0,3}[:=]\\s{0,3}(?:\\\\?["'])?)([^\\s"'\`<>,;{}()\\[\\]&\\\\]{6,})`,
  "gi"
);
const SECRET_KEY = new RegExp(`(?:${SECRET_NAME})$`, "i");

/** Under a secret's name but not one: a number, a path, a reference, a stand-in. */
const STAND_IN =
  /^(?:\d+|https?:.*|[.~]?\/.*|\$.*|%.*|your[_-].*|example.*|placeholder.*|change[_-]?me.*|redacted.*|x{3,}.*|\*.*|.*(?:\.{3}|…))$/i;

/** In running text: `password: required`, `token = session.user?.accessToken`. */
const WORDS = /^[a-z_]+(?:\??[.-][a-z_]+)*[?!.:]*$/i;

/**
 * A quoted name and a quoted value are a JSON pair, as in a tool's arguments,
 * which arrive as one string: the name is certain, so a plain word goes too.
 */
const JSON_PAIR = /["']\s{0,3}:\s{0,3}\\?["']$/;

/** A pasted image or file is the longest string there is, and holds no typed key. */
const DATA_URI = /^data:[a-z]+\/[a-z0-9.+-]+;base64,/;

const looksRandom = (part: string): boolean =>
  part.length >= SK_KEY_MIN_PART_LENGTH &&
  /\d/.test(part) &&
  /[A-Za-z]/.test(part);

const looksRandomRunOn = (part: string): boolean =>
  part.length >= SK_KEY_RUN_ON_MIN_PART_LENGTH &&
  /\d/.test(part) &&
  part.toLowerCase() !== part &&
  part.toUpperCase() !== part;

/**
 * Credentials out of one text, nothing else. The server runs the same rules
 * over what reaches it (older versions upload unscrubbed); keep the two lists
 * together. A value is masked for its shape, or for its name when it does not
 * read like a word, a number, a path or code, so ordinary text comes through.
 * Running it twice changes nothing.
 */
export function scrubKeys(text: string): string {
  if (DATA_URI.test(text)) return text;

  let out = text.replace(ESCAPED_WHITESPACE, `$1${ESCAPE_BREAK}`);

  for (const shape of KEY_SHAPES) out = out.replace(shape, MASKED_KEY);

  return out
    .replace(SK_KEY, (key: string, offset: number, whole: string) => {
      const runsOn = offset > 0 && /[A-Za-z0-9_]/.test(whole[offset - 1]!);

      return key.split(/[-_]/).some(runsOn ? looksRandomRunOn : looksRandom)
        ? MASKED_KEY
        : key;
    })
    .replace(WEBHOOK, `$1${MASKED_KEY}`)
    .replace(URL_CREDENTIAL, `$1${MASKED_VALUE}$3`)
    .replace(BEARER, (whole, prefix: string, token: string) =>
      /\d/.test(token) ? `${prefix}${MASKED_VALUE}` : whole
    )
    .replace(AUTH_HEADER, `$1${MASKED_VALUE}`)
    .replace(NAMED_SECRET, (whole, name: string, value: string) =>
      STAND_IN.test(value) || (WORDS.test(value) && !JSON_PAIR.test(name))
        ? whole
        : `${name}${MASKED_VALUE}`
    )
    .replaceAll(ESCAPE_BREAK, "");
}

/** A string under a secret's own key: only a stand-in or a sentence stays. */
const scrubNamedValue = (value: string): string => {
  if (
    value.length < MIN_SECRET_LENGTH ||
    value.startsWith("<") ||
    STAND_IN.test(value)
  )
    return scrubKeys(value);
  const isSentence =
    value.trim().split(/\s+/).length >= MIN_SENTENCE_WORDS &&
    !value.includes("=");

  return isSentence ? scrubKeys(value) : MASKED_VALUE;
};

/**
 * A copy of a JSON value with its strings scrubbed at any depth: chat text,
 * tool arguments and tool results alike. For what leaves this machine; the
 * value itself, and so the user's own copy, is left as it is.
 */
export function scrubValue<T>(value: T, key = ""): T {
  if (typeof value === "string")
    return (
      SECRET_KEY.test(key) ? scrubNamedValue(value) : scrubKeys(value)
    ) as T;
  if (Array.isArray(value))
    return value.map((item: unknown) => scrubValue(item, key)) as T;
  if (
    value == null ||
    typeof value !== "object" ||
    Object.getPrototypeOf(value) !== Object.prototype
  )
    return value;

  return Object.fromEntries(
    Object.entries(value).map(([name, item]) => [
      scrubKeys(name),
      scrubValue(item, name),
    ])
  ) as T;
}

/**
 * Scrub one text: key shapes, named secrets, and the user's own name. Log text
 * goes to disk a flush at a time, so a key can start in one and end in the
 * next: the first masks to its end, and this masks the second up to the key's
 * last line.
 */
export function scrub(text: string, homeDir?: string): string {
  let out = scrubKeys(text).replace(PRIVATE_KEY_END, MASKED_KEY);

  // The user's name is the parent of `~/.abacusai-bot`; the OS's answer is
  // read too, because either can be the one that appears in the paths.
  const candidates = new Set<string>();

  for (const name of [
    homeDir != null ? path.basename(path.dirname(homeDir)) : "",
    safely(() => path.basename(os.homedir())),
    safely(() => os.userInfo().username),
  ]) {
    if (name.length > 2 && name !== "unknown") candidates.add(name);
  }

  for (const name of candidates) out = out.split(name).join("<user>");

  return out;
}

function safely(read: () => string): string {
  try {
    return read();
  } catch {
    return "unknown";
  }
}
