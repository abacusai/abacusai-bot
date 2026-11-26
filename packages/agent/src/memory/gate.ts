/**
 * The checks every note passes before it is written, whichever model wrote
 * it. Each refusal is one line that names the call that would succeed, so a
 * small model can fix its call on the next step. Pure functions: the tool and
 * the Memory page run them under the folder's lock.
 */
import { redactIdNumbers } from "../traveler/id-numbers.js";
import { oneLine, type Note, type NoteType } from "./notes.js";

export const MAX_NOTE_CHARS = 1_500;
export const MAX_CARD_CHARS = 3_000;
/** One finished task, as models write it: 800-900 characters. A recalled line costs no more than a note. */
export const MAX_JOURNAL_CHARS = 1_000;
/** What one scope may put in the prompt: full rules and preferences plus one line per other note. */
export const MAX_SCOPE_CORE_CHARS = 3_000;
const MAX_DESCRIPTION_CHARS = 150;
const MAX_KEYWORDS_CHARS = 200;
/** Rules ride in every request as the standing instructions: a page of house style fits. */
export const MAX_RULES_CHARS = 8_000;
const MAX_STATUS_DAYS = 14;
/** Above this word overlap a new note restates an existing one. */
const DUPLICATE_OVERLAP = 0.6;
const RELATED_OVERLAP = 0.2;

// ── secrets ────────────────────────────────────────────────────────────────
//
// A note that holds a secret is refused whole. `looksSecret` runs the patterns
// the gate has always refused on, unchanged in what they match, on the text as
// written, and adds to them on the text folded: more provider formats, labels
// written in full-width or split by invisible characters, and secrets a person
// chose (a password, a PIN, a recovery phrase).

/** Past this a text is treated as secret without reading it: notes are far shorter. */
const MAX_SCAN_CHARS = 100_000;

/** Characters that show nothing, so a key or a label split by one still reads as one. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/** Hyphens that stand in for "-" ("sk‐…"). Em and en dashes are prose and stay. */
const DASH = /[‐‑−﹣－]/u;
/** Text as the added patterns read it: full-width and other compatibility forms folded, invisible characters dropped. */
const folded = (text: string): string => {
  let out = "";
  for (const char of text)
    out += INVISIBLE.test(char)
      ? ""
      : DASH.test(char)
        ? "-"
        : char.normalize("NFKC");
  return out;
};

/**
 * The patterns the gate has always refused on. Two are read run by run
 * (`EARLIER_RUN`, `hasJwt`): the same matches, without rescanning a long run
 * once per position. gate.test.ts checks nothing they found is missed.
 */
const EARLIER_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  // "my password is …", "PIN: 4821", "api key = …"
  /\b(?:password|passwd|passcode|passphrase|pass phrase|pin|pin code|api[ _-]?key|access[ _-]?key|secret|token|otp|security code)\b\s*(?:is|was|=|:|-)\s*["'`]?[^\s"'`]{3,}/i,
];
/** The earlier long-run pattern, read run by run: it can only match inside one run of 32+ holding letters and digits. */
const EARLIER_RUN =
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/;
/** As /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/: three dot-joined runs, the first ending in "eyJ" and 10+ more. */
const EARLIER_JWT_START = /\beyJ[A-Za-z0-9_-]{10,}$/;
const hasJwt = (text: string): boolean => {
  const runs = [...text.matchAll(/[A-Za-z0-9_-]+/g)];
  return runs.some((first, i) => {
    const second = runs[i + 1];
    const third = runs[i + 2];
    if (second == null || third == null) return false;
    const firstEnd = first.index + first[0].length;
    const secondEnd = second.index + second[0].length;
    return (
      text[firstEnd] === "." &&
      second.index === firstEnd + 1 &&
      second[0].length >= 10 &&
      text[secondEnd] === "." &&
      third.index === secondEnd + 1 &&
      third[0].length >= 5 &&
      EARLIER_JWT_START.test(first[0])
    );
  });
};
/** The earlier long-run pattern over each run of 32+ that holds letters and digits. */
const longRunFinds = (text: string): boolean =>
  (text.match(/[A-Za-z0-9_-]{32,}/g) ?? []).some(
    (run) => /\d/.test(run) && /[A-Za-z]/.test(run) && EARLIER_RUN.test(run)
  );
const earlierFinds = (text: string): boolean =>
  EARLIER_PATTERNS.some((pattern) => pattern.test(text)) ||
  hasJwt(text) ||
  longRunFinds(text);

/** Where a word starts, as `\b` before a word character. */
const RUN_START = "(?<![A-Za-z0-9_])";

/** Formats issued by known providers, and key material. */
const SECRET_FORMATS: readonly RegExp[] = [
  `${RUN_START}(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}`,
  `${RUN_START}glpat-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}xapp-\\d-[A-Za-z0-9-]{10,}`,
  `${RUN_START}AKIA[0-9A-Z]{16}(?![0-9A-Z])`,
  `${RUN_START}GOCSPX-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}ya29\\.[A-Za-z0-9._-]{20,}`,
  `(?<![A-Za-z0-9/])1//0[A-Za-z0-9_-]{20,}`,
  `${RUN_START}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`,
  `${RUN_START}(?:whsec|npm|hf|shpat|shpss|shpca|dop_v1|glsa|pypi)_[A-Za-z0-9_-]{20,}`,
  `${RUN_START}sq0(?:atp|csp)-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}\\d{8,10}:AA[A-Za-z0-9_-]{30,}`,
  `(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}`,
  `AccountKey=[A-Za-z0-9+/]{20,}={0,2}`,
  // Webhook URLs whose path is the credential.
  `hooks\\.slack\\.com/services/[A-Za-z0-9/]{20,}`,
  `maker\\.ifttt\\.com/[^\\s]{0,100}/key/[A-Za-z0-9_-]{16,}`,
  `-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----`,
].map((source) => new RegExp(source));

/**
 * 40+ characters of base64 with "+" or "/": an AWS secret key, a base64 key.
 * Not from inside a URL, whose segments the run rule reads.
 */
const BASE64_RUN =
  /(?<![A-Za-z0-9+/=.:])(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{40,}={0,2}/g;
/** A folder name: words, a year or a short code ("Contracts", "2026", "ROG2026", "Q1"). */
const FOLDER =
  /^(?:[A-Z]?[a-z]{2,}(?:[A-Z][a-z]+)*\d{0,4}|\d{1,4}|[A-Z]{1,4}\d{0,4})$/;
/**
 * A run that names a file or folder, not a key: it goes on to an extension
 * (".../index.tsx"), starts at a root ("/", "~/", "./"), or is mostly folder
 * names with no segment long enough for the run rule ("Clients/Acme/<id>/Contracts").
 */
const isPath = (run: string, at: number, text: string): boolean => {
  if (
    /^\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(
      text.slice(at + run.length, at + run.length + 10)
    ) ||
    run.startsWith("/") ||
    /[~.]$/.test(text.slice(Math.max(0, at - 1), at))
  )
    return true;
  const parts = run.split("/");
  const folders = parts.filter((part) => FOLDER.test(part)).length;
  return (
    parts.length >= 3 &&
    folders * 2 >= parts.length &&
    parts.every((part) => part.length < 32)
  );
};
const base64Finds = (text: string): boolean =>
  [...text.matchAll(BASE64_RUN)].some(
    (match) => !isPath(match[0], match.index, text)
  );

/**
 * Words a secret is named by. A value after one, as in "PIN: 4821", is the
 * secret. Label words may be split by spaces, a line break or "_"/"-"
 * ("api\nkey", "secret_access_key").
 */
const SECRET_LABEL = [
  "password",
  "passwd",
  "passcode",
  "passphrase",
  "pass phrase",
  "pin code",
  "pin",
  "otp",
  "security code",
  "cvv",
  "cvc",
  "recovery phrase",
  "recovery code",
  "seed phrase",
  "seed words",
  "backup code",
  "api key",
  "access key",
  "secret access key",
  "client secret",
  "auth token",
  "private key",
  "secret",
  "token",
]
  .map((label) => label.replaceAll(" ", "[\\s_-]{0,3}"))
  .join("|");
/** Labels the earlier patterns did not have: a dash after one is prose ("the private key - ed25519 - is …"). */
const ADDED_LABEL =
  /^(?:secret[\s_-]*access[\s_-]*key|client[\s_-]*secret|auth[\s_-]*token|private[\s_-]*key)$/i;
const LABELLED_SECRET = new RegExp(
  `(?<![A-Za-z])(${SECRET_LABEL})(?![A-Za-z])(\\s*(?:is|was|=|:|-)\\s*)(?=["'\`]?[^\\s"'\`]{3,})`,
  "gi"
);
/** Where a note says where a secret is kept rather than what it is: "is stored in ~/.ssh", "is in the .env file". */
const KEPT_AT =
  /^(?:(?:stored|kept|saved|held|located|lives?)\s+(?:in|at|on|under|inside)|in|inside|at|under)\s/i;
/** Whether a value is said after its label. */
const labelledFinds = (text: string): boolean => {
  for (const match of text.matchAll(LABELLED_SECRET)) {
    if (ADDED_LABEL.test(match[1]!) && match[2]!.includes("-")) continue;
    const from = match.index + match[0].length;
    if (KEPT_AT.test(text.slice(from, from + 30))) continue;
    return true;
  }
  return false;
};

/**
 * Whether `text` holds a secret: anything the earlier patterns find in the
 * text as written, and anything the added patterns find in it folded.
 */
export const looksSecret = (text: string): boolean => {
  if (text.length > MAX_SCAN_CHARS) return true;
  if (earlierFinds(text)) return true;
  const read = folded(text);
  return (
    SECRET_FORMATS.some((pattern) => pattern.test(read)) ||
    hasJwt(read) ||
    base64Finds(read) ||
    labelledFinds(read) ||
    longRunFinds(read)
  );
};

// ── claims that must not be saved ──────────────────────────────────────────

/** "X doesn't exist", "not found", "no access": usually a failed search, not a fact. */
const ABSENCE =
  /\b(?:does ?n[o']?t|do ?n[o']?t|is ?n[o']?t|are ?n[o']?t|was ?n[o']?t|were ?n[o']?t|no longer|never)\s+(?:exists?|available|installed|found|there|accessible|reachable|present)\b|\b(?:not found|no such (?:file|folder|directory)|can ?n[o']?t (?:find|locate|access)|could ?n[o']?t (?:find|locate|access)|unable to (?:find|locate|access)|no access|does not exist|doesn't exist|missing)\b/i;

/** State the app reads live: a routine paused, a connector connected. */
const LIVE_STATE =
  /\b(?:is|are|was|were|got|now)\s+(?:now\s+|currently\s+)?(?:paused|resumed|running|stopped|enabled|disabled|connected|disconnected|unpaused|switched (?:on|off)|turned (?:on|off)|logged (?:in|out)|signed (?:in|out))\b|\b(?:not|isn['’]?t|aren['’]?t)\s+(?:connected|running|enabled|logged in|signed in)\b/i;

const STOP_WORDS = new Set(
  "the a an and or but of to in on at for with from by is are was were be been it its this that these those as not no do does did has have had i you we they he she my your our their me us them will would can could should about into over than then there here what which who when where why how all any some just only also very".split(
    " "
  )
);

/** Lower-cased content words, crudely stemmed, for overlap scores. */
/** Scripts written without spaces: matched by pairs of characters instead of words. */
const UNSPACED =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

export const contentWords = (text: string): Set<string> => {
  const words = new Set<string>();
  // Marks belong to their word: Indic vowel signs are marks, not letters.
  for (const word of text
    .normalize("NFC")
    .toLowerCase()
    .split(/[^\p{L}\p{M}\p{N}]+/u)) {
    if (UNSPACED.test(word)) {
      for (let at = 0; at + 1 < word.length; at += 1)
        words.add(word.slice(at, at + 2));
      continue;
    }
    if (word.length < 3 || STOP_WORDS.has(word)) continue;
    const stem = word.replace(/(?:ing|ed|es|s)$/, "");
    if (stem.length >= 3) words.add(stem);
  }
  return words;
};

/** Share of the smaller set's words found in the other. */
const containment = (a: Set<string>, b: Set<string>): number => {
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  if (small.size === 0) return 0;
  let shared = 0;
  for (const word of small) if (large.has(word)) shared += 1;
  return shared / small.size;
};

/** Jaccard overlap of two word sets. */
export const overlap = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared += 1;
  return shared / (a.size + b.size - shared);
};

/**
 * Whether the user said this themselves this turn: their own words carry the
 * same kind of claim about the same things.
 */
const userSaidIt = (claim: RegExp, text: string, userWords: string): boolean =>
  claim.test(userWords) &&
  containment(contentWords(text), contentWords(userWords)) >= 0.5;

/** Sentences and list items: the unit a claim is made in. A list joined by commas is one claim. */
const sentencesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?;])\s+|\r?\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Whether the note is that claim: the sentences making it hold most of the
 * note's words. A long note that mentions in passing that a branch does not
 * exist yet, or that a rule switches auto-reply off, is about something else
 * and is kept.
 */
const isTheClaim = (claim: RegExp, text: string): boolean => {
  const all = contentWords(text).size;
  if (all === 0) return false;
  const claimed = new Set<string>();
  for (const sentence of sentencesOf(text))
    if (claim.test(sentence))
      for (const word of contentWords(sentence)) claimed.add(word);
  return claimed.size * 2 >= all;
};

// ── the checks ─────────────────────────────────────────────────────────────

export interface Draft {
  name: string;
  description: string;
  type: NoteType;
  body: string;
  expires?: string;
  keywords?: string;
}

export interface GateInput {
  draft: Draft;
  /** The other notes of the same scope, as they are now. */
  siblings: readonly Note[];
  /** The note this one updates, or replaces by `replaces`, when any. */
  updating: string | null;
  /** What the user typed this turn, their own words only. */
  userWords: string;
  /** The Memory page: the user's own edit, which skips the claim checks. */
  byUser: boolean;
  now: Date;
}

const DAY_MS = 86_400_000;

const sizeLimit = (type: NoteType): number =>
  type === "card" ? MAX_CARD_CHARS : MAX_NOTE_CHARS;

/** What a note puts in the prompt: rules, preferences and the profile whole, others as a line. */
export const coreChars = (
  note: Pick<Note, "type" | "body" | "description" | "name">
): number =>
  note.type === "rule" || note.type === "preference" || note.type === "profile"
    ? note.body.length + note.name.length + 4
    : note.name.length + note.description.length + 12;

/**
 * The draft, cleaned, or the one-line reason it cannot be saved. ID numbers
 * are withheld rather than refused: the rest of the note is still worth keeping.
 */
export const checkDraft = (input: GateInput): Draft | string => {
  const { draft, siblings, updating, userWords, byUser, now } = input;
  const body = redactIdNumbers(draft.body.trim());
  const description = (draft.description.trim() || firstSentence(body)).slice(
    0,
    MAX_DESCRIPTION_CHARS
  );

  const keywords = oneLine(draft.keywords ?? "").slice(0, MAX_KEYWORDS_CHARS);

  if (body.length === 0) return "Nothing to save: the text is empty.";
  if (body.length > sizeLimit(draft.type))
    return `That is ${body.length} characters; a ${draft.type === "card" ? "project card" : "note"} holds ${sizeLimit(draft.type)}. Keep one fact per note, or split it.`;

  if (looksSecret(`${description}\n${body}\n${keywords}`))
    return byUser
      ? "That looks like a password, key or code. Memory never keeps those; the vault is the place for them."
      : "That looks like a password, key or code. Memory never keeps those: suggest the user keeps it in the app's vault, and save only where it is kept.";

  if (draft.type === "status") {
    const expires = Date.parse(draft.expires ?? "");
    if (Number.isNaN(expires))
      return 'A status note needs "expires" (YYYY-MM-DD), at most 14 days ahead.';
    if (expires < now.getTime() - DAY_MS)
      return "That expiry date is already past.";
    if (expires > now.getTime() + MAX_STATUS_DAYS * DAY_MS)
      return byUser
        ? `A status note may last ${MAX_STATUS_DAYS} days at most. Save lasting facts as a fact or a decision.`
        : `A status note may last ${MAX_STATUS_DAYS} days at most. Save lasting facts as type "fact" or "decision".`;
  }

  const text = `${description}\n${body}`;
  if (!byUser && draft.type !== "card") {
    if (
      isTheClaim(LIVE_STATE, text) &&
      !userSaidIt(LIVE_STATE, text, userWords)
    )
      return "Not saved: whether something is connected, paused or running is read live each time, never from memory. Check it with the relevant tool instead.";
    if (
      draft.type !== "rule" &&
      draft.type !== "preference" &&
      isTheClaim(ABSENCE, text) &&
      !userSaidIt(ABSENCE, text, userWords)
    )
      return "Not saved: a search or tool that found nothing is not a fact (the item may be hidden, renamed or elsewhere). Save it only if the user says so.";
  }

  if (updating == null && siblings.some((note) => note.name === draft.name))
    return byUser
      ? `A note called "${draft.name}" exists already. Edit that one instead.`
      : `A note called "${draft.name}" exists. Use action "update" with name "${draft.name}".`;

  const words = contentWords(text);
  const twin = siblings.find(
    (note) =>
      note.name !== updating &&
      note.type !== "card" &&
      overlap(words, contentWords(`${note.description}\n${note.body}`)) >=
        DUPLICATE_OVERLAP
  );
  if (twin != null)
    return byUser
      ? `That says the same as "${twin.description}". Edit that note instead.`
      : twin.by === "you"
        ? `The user's own note "${twin.name}" already says this; nothing to save.`
        : `That restates the note "${twin.name}" (${twin.description}). Update it instead: action "update", name "${twin.name}".`;

  // Rules have their own room (they are the standing instructions); the rest share the core's.
  const isRule = draft.type === "rule";
  const used = siblings
    .filter((note) => note.name !== updating && note.name !== draft.name)
    .filter((note) => (note.type === "rule") === isRule)
    .reduce((sum, note) => sum + coreChars(note), 0);
  if (
    draft.type !== "card" &&
    used + coreChars({ ...draft, body, description }) >
      (isRule ? MAX_RULES_CHARS : MAX_SCOPE_CORE_CHARS)
  )
    return byUser
      ? "This part of memory is full. Merge two notes or forget one that no longer matters, then save again."
      : 'This memory is full. Merge two related notes with "update", or "forget" one that no longer matters, then save again.';

  const { keywords: _given, ...rest } = draft;
  return {
    ...rest,
    body,
    description,
    ...(keywords.length > 0 ? { keywords } : {}),
  };
};

/** Up to three notes of the scope that look related, most related first. */
export const relatedNotes = (
  draft: Draft,
  siblings: readonly Note[]
): Note[] => {
  const words = contentWords(`${draft.description}\n${draft.body}`);
  return siblings
    .filter((note) => note.name !== draft.name && note.type !== "card")
    .map((note) => ({
      note,
      score: overlap(words, contentWords(`${note.description}\n${note.body}`)),
    }))
    .filter(({ score }) => score >= RELATED_OVERLAP)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ note }) => note);
};

const firstSentence = (body: string): string => {
  const line = body.split(/\r?\n/).find((each) => each.trim().length > 0) ?? "";
  const sentence = /^(.+?[.!?])(\s|$)/.exec(line.trim());
  return (sentence?.[1] ?? line).trim();
};
