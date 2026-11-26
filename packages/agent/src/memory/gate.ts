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
// A secret is withheld where it stands, as ID numbers are: the rest of the
// note is still worth keeping. Only shapes that are credentials count, so a
// file name, a UUID or a dated id built from words is kept as written.

export const SECRET_WITHHELD = "[secret withheld]";

/** Formats issued by known providers, and key material. */
const SECRET_FORMATS: RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/g,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g,
  /\bAKIA[0-9A-Z]{16}\b/g,
  /\bAIza[0-9A-Za-z_-]{30,}/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/gi,
];

/** Labels whose value is a credential however it is said: "the password is sunshine". */
const STRONG_LABEL =
  "password|passwd|passcode|passphrase|pass phrase|pin code|pin|otp|security code";
/** Labels plain talk uses too: "the token is dead", "the secret is out". */
const WEAK_LABEL = "api[ _-]?key|access[ _-]?key|secret|token";

const LABELLED_SECRET = new RegExp(
  `\\b(?:(${STRONG_LABEL})|${WEAK_LABEL})(\\s*[:=]\\s*|\\s+-\\s+|\\s+(?:is|was)\\s*[:=]?\\s*)`,
  "gi"
);
const CREDENTIAL_SHAPED = /\d|[^\p{L}\p{N}]|\p{Ll}\p{Lu}/u;
/** A variable that holds the secret, not the secret: GITHUB_TOKEN, ${DB_PASSWORD}. */
const VARIABLE_NAME = /^[$%{]*[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+[}%]*$/;
/** First words after "password is" that describe it rather than give it. */
const NOT_A_VALUE = new Set(
  "the not required needed wrong correct incorrect invalid valid expired changed reset same different stored saved kept set still now also unknown missing empty blank too very being managed shared sent protected hidden there here inside with from for and but his her their our your its".split(
    " "
  )
);
/**
 * Where a password said in words ends: a clause break, or where the note goes
 * on to say where it is kept. A passphrase can have spaces.
 */
const PHRASE_END =
  /[,;](?=\s)|[.!?]+(?=\s|$)|\n|\s(?:in|inside|at|from|under|stored|saved|kept|on)\s/i;

/** Where the value after a label starts and ends, or null when there is none. */
const valueSpan = (
  text: string,
  from: number,
  gap: string,
  strong: boolean
): [number, number] | null => {
  const quote = text[from];
  if (quote === '"' || quote === "'" || quote === "`") {
    const close = text.indexOf(quote, from + 1);
    if (close > from + 1 && !text.slice(from, close).includes("\n"))
      return [from + 1, close];
  }
  const rest = text.slice(from);
  // A key or a value after "=" (as in a URL) is one run; a password may be a phrase.
  const stop =
    strong && !gap.includes("=")
      ? rest.search(PHRASE_END)
      : rest.search(/[\s&]/);
  let end = from + (stop < 0 ? rest.length : stop);
  while (end > from && /[.,;:!?)\]]/.test(text[end - 1]!)) end -= 1;
  return end - from >= 3 ? [from, end] : null;
};

/** Each value said after its label: a key as one run, a password to the end of its phrase. */
const withholdLabelled = (text: string): { text: string; withheld: number } => {
  let out = "";
  let at = 0;
  let withheld = 0;
  LABELLED_SECRET.lastIndex = 0;
  for (
    let match = LABELLED_SECRET.exec(text);
    match != null;
    match = LABELLED_SECRET.exec(text)
  ) {
    const strong = match[1] != null;
    const gap = match[2]!;
    const span = valueSpan(text, match.index + match[0].length, gap, strong);
    if (span == null) continue;
    const value = text.slice(...span);
    const first = value.split(/\s/)[0]!;
    if (value.startsWith(SECRET_WITHHELD) || VARIABLE_NAME.test(first))
      continue;
    const said = /(?:is|was)/i.test(gap);
    if (
      strong
        ? said && (first.length < 3 || NOT_A_VALUE.has(first.toLowerCase()))
        : !CREDENTIAL_SHAPED.test(first)
    )
      continue;
    out += text.slice(at, span[0]) + SECRET_WITHHELD;
    at = span[1];
    withheld += 1;
    LABELLED_SECRET.lastIndex = span[1];
  }
  return { text: out + text.slice(at), withheld };
};

/** A long run of letters and digits with no word structure: a random key or signed token. */
const RANDOM_RUN = /[A-Za-z0-9_-]{32,}/g;
/** Where a run splits into words: lower to upper case, letters to digits and back. */
const WORD_BREAK = /(?<=\p{Ll})(?=\p{Lu})|(?<=\p{L})(?=\d)|(?<=\d)(?=\p{L})/u;
/** Average word length from which a run reads as words (DocumentRoutingEngineV1), not noise. */
const MIN_WORDY_LENGTH = 4;
const isRandom = (run: string): boolean =>
  run.split(/[_-]+/).some((part) => {
    if (part.length < 16 || !/\d/.test(part) || !/[A-Za-z]/.test(part))
      return false;
    return part.length / part.split(WORD_BREAK).length < MIN_WORDY_LENGTH;
  });
/** A run the note names as an id or a checksum ("doc id …", "md5 …", "commit …"). */
const NAMED_AS_ID =
  /(?<![A-Za-z])(?:ids?|uuid|md5|sha-?\d*|hash|checksum|commit|revision|zone)\b[\s:=#(`'"]{0,3}$/i;
/**
 * A run in a URL's path names a page or file (a Drive doc, a commit); a secret
 * in a URL rides its query, or the path of a webhook or bot URL.
 */
const IN_URL_PATH = /https?:\/\/[^\s?#]*$/;
const CREDENTIAL_URL = /hook|bot|token|secret|key|sig|auth|cred|pass/i;
const inDocumentUrl = (before: string): boolean => {
  const url = IN_URL_PATH.exec(before);
  return url != null && !CREDENTIAL_URL.test(url[0]);
};

/** `text` with every secret replaced by `SECRET_WITHHELD`, and how many there were. */
export const withholdSecrets = (
  text: string
): { text: string; withheld: number } => {
  let withheld = 0;
  let out = text;
  for (const format of SECRET_FORMATS)
    out = out.replace(format, () => {
      withheld += 1;
      return SECRET_WITHHELD;
    });
  const labelled = withholdLabelled(out);
  withheld += labelled.withheld;
  out = labelled.text.replace(RANDOM_RUN, (run, at: number, all: string) => {
    const before = all.slice(Math.max(0, at - 200), at);
    if (!isRandom(run) || NAMED_AS_ID.test(before) || inDocumentUrl(before))
      return run;
    withheld += 1;
    return SECRET_WITHHELD;
  });
  return { text: out, withheld };
};

export const looksSecret = (text: string): boolean =>
  withholdSecrets(text).withheld > 0;

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

/** Clauses and list items: the unit a claim is made in, so one long sentence is not one claim. */
const clausesOf = (text: string): string[] =>
  text
    .split(/(?<=[.!?;:,)])\s+|\s+[—–-]\s+|\s+\(|\r?\n+/)
    .map((part) => part.trim())
    .filter((part) => part.length > 0);

/**
 * Whether the note is that claim: the clauses making it hold most of the
 * note's words. A long note that mentions in passing that a branch does not
 * exist yet, or that a rule switches auto-reply off, is about something else
 * and is kept.
 */
const isTheClaim = (claim: RegExp, text: string): boolean => {
  const all = contentWords(text).size;
  if (all === 0) return false;
  const claimed = new Set<string>();
  for (const clause of clausesOf(text))
    if (claim.test(clause))
      for (const word of contentWords(clause)) claimed.add(word);
  return claimed.size * 2 >= all;
};

/** Words that only name a secret, the placeholder's own words among them. */
const SECRET_WORDS = contentWords(
  `${SECRET_WITHHELD} password passwd passcode passphrase pass phrase pin code otp security api key access token login credential`
);
const MIN_WORDS_BESIDE_SECRET = 3;

/**
 * Whether `text` holds a secret and next to nothing else ("Stripe key: …",
 * "PIN: 4821"): withholding it would leave no fact worth keeping.
 */
export const onlySecret = (text: string): boolean => {
  const kept = withholdSecrets(text);
  if (kept.withheld === 0) return false;
  let left = 0;
  for (const word of contentWords(kept.text))
    if (!SECRET_WORDS.has(word)) left += 1;
  return left < MIN_WORDS_BESIDE_SECRET;
};

/** Told to the model when a secret was withheld from what it saved. */
export const SECRET_WITHHELD_NOTICE =
  "A password, key or code in it was withheld; suggest the user keeps it in the app's vault.";

/** Whether saving `sent` withheld a secret from it: what checkDraft does when it keeps such a note. */
export const secretWithheld = (sent: Draft): boolean =>
  looksSecret(`${sent.description}\n${sent.body}\n${sent.keywords ?? ""}`);

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
  let body = redactIdNumbers(draft.body.trim());
  let description = (draft.description.trim() || firstSentence(body)).slice(
    0,
    MAX_DESCRIPTION_CHARS
  );

  let keywords = oneLine(draft.keywords ?? "").slice(0, MAX_KEYWORDS_CHARS);

  if (body.length === 0) return "Nothing to save: the text is empty.";
  if (body.length > sizeLimit(draft.type))
    return `That is ${body.length} characters; a ${draft.type === "card" ? "project card" : "note"} holds ${sizeLimit(draft.type)}. Keep one fact per note, or split it.`;

  // The user's own edit is told; a model's note keeps everything but the secret.
  if (looksSecret(`${description}\n${body}\n${keywords}`)) {
    if (byUser)
      return "That looks like a password, key or code. Memory never keeps those; the vault is the place for them.";
    if (onlySecret(body))
      return "That is a password, key or code and nothing else. Memory never keeps those: suggest the user keeps it in the app's vault, and save only where it is kept.";
    description = withholdSecrets(description).text;
    body = withholdSecrets(body).text;
    keywords = withholdSecrets(keywords).text;
  }

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
