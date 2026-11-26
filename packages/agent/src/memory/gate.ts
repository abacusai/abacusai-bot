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
// Two jobs. `looksSecret` detects: it flags at least everything the gate has
// always flagged, and the refusals, the Memory page, the handover and the
// migration use it. `withholdSecrets` redacts: a model's note is kept with its
// secrets withheld only when `looksSecret` finds nothing left in the result.

export const SECRET_WITHHELD = "[secret withheld]";
/** Past this a text is treated as secret without reading it: notes are far shorter. */
const MAX_SCAN_CHARS = 100_000;
/**
 * An unbroken run of word characters or of spaces longer than this is treated
 * as secret: no note has one, and it is where a pattern could slow to a crawl.
 */
const MAX_RUN_CHARS = 1_000;
const LONG_RUN = new RegExp(
  `[A-Za-z0-9_-]{${MAX_RUN_CHARS + 1}}|\\s{${MAX_RUN_CHARS + 1}}`
);
/** The longest value read after a label such as "password:". */
const MAX_VALUE_CHARS = 300;

/** Characters that show nothing, so a key split by one still reads as one. */
const INVISIBLE = /[​-‍⁠﻿]/g;
/** Text as the checks read it: full-width and other compatibility forms folded, invisible characters dropped. */
const fold = (text: string): string =>
  text.normalize("NFKC").replace(INVISIBLE, "");

/**
 * The patterns the gate has always refused on, exactly as they were.
 * `looksSecret` runs them unchanged, so the patterns below only add to them.
 */
const EARLIER_PATTERNS: readonly RegExp[] = [
  /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/,
  /\bbearer\s+[A-Za-z0-9._~+/-]{16,}/i,
  // "my password is …", "PIN: 4821", "api key = …"
  /\b(?:password|passwd|passcode|passphrase|pass phrase|pin|pin code|api[ _-]?key|access[ _-]?key|secret|token|otp|security code)\b\s*(?:is|was|=|:|-)\s*["'`]?[^\s"'`]{3,}/i,
  // A long run of mixed letters and digits: keys, tokens, signed URLs.
  /\b(?=[A-Za-z0-9_-]{32,}\b)(?=[A-Za-z_-]*\d)(?=[0-9_-]*[A-Za-z])[A-Za-z0-9_-]{32,}\b/,
];
/** The earlier formats (all but the labelled value and the long run), to withhold what they find. */
const EARLIER_FORMATS: readonly RegExp[] = EARLIER_PATTERNS.slice(0, 9).map(
  (pattern) => new RegExp(pattern.source, `${pattern.flags}g`)
);

/** Where a word starts, as `\b` before a word character. */
const RUN_START = "(?<![A-Za-z0-9_])";

/** Formats issued by known providers, and key material: withheld whole. */
const SECRET_FORMATS: RegExp[] = [
  `${RUN_START}(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}`,
  `${RUN_START}gh[pousr]_[A-Za-z0-9]{20,}`,
  `${RUN_START}github_pat_[A-Za-z0-9_]{20,}`,
  `${RUN_START}glpat-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}xox[abprs]-[A-Za-z0-9-]{10,}`,
  `${RUN_START}xapp-\\d-[A-Za-z0-9-]{10,}`,
  `${RUN_START}AKIA[0-9A-Z]{16}(?![0-9A-Z])`,
  `${RUN_START}AIza[0-9A-Za-z_-]{30,}`,
  `${RUN_START}GOCSPX-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}ya29\\.[A-Za-z0-9._-]{20,}`,
  `(?<![A-Za-z0-9/])1//0[A-Za-z0-9_-]{20,}`,
  `${RUN_START}SG\\.[A-Za-z0-9_-]{16,}\\.[A-Za-z0-9_-]{16,}`,
  `${RUN_START}(?:whsec|npm|hf|shpat|shpss|shpca|dop_v1|glsa|pypi)_[A-Za-z0-9_-]{20,}`,
  `${RUN_START}sq0(?:atp|csp)-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}\\d{8,10}:AA[A-Za-z0-9_-]{30,}`,
  `${RUN_START}[MNO][A-Za-z0-9_-]{23,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}`,
  `AccountKey=[A-Za-z0-9+/]{20,}={0,2}`,
  // Webhook URLs whose path is the credential.
  `(?<=hooks\\.slack\\.com/services/)[A-Za-z0-9/]{20,}`,
  `(?<=maker\\.ifttt\\.com/[^\\s]{0,100}/key/)[A-Za-z0-9_-]{16,}`,
  `-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)`,
  `${RUN_START}eyJ[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{10,}\\.[A-Za-z0-9_-]{5,}`,
  `\\bbearer\\s+[A-Za-z0-9._~+/-]{16,}`,
].map((source) => new RegExp(source, source.includes("bearer") ? "gi" : "g"));

/**
 * 40+ characters of base64 with "+" or "/": an AWS secret key, a base64 key.
 * Not from inside a URL, whose segments the run rule reads.
 */
const BASE64_RUN =
  /(?<![A-Za-z0-9+/=.:])(?=[A-Za-z0-9+/]*[+/])(?=[A-Za-z0-9+/]*\d)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])[A-Za-z0-9+/]{40,}={0,2}/g;
/** A run that names a file: it goes on to an extension (".../index.tsx") or starts at a root ("/", "~/", "./"). */
const isPath = (run: string, at: number, text: string): boolean =>
  /^\.[A-Za-z0-9]{1,8}(?![A-Za-z0-9])/.test(
    text.slice(at + run.length, at + run.length + 10)
  ) ||
  run.startsWith("/") ||
  /[~.]$/.test(text.slice(Math.max(0, at - 1), at));

/** Words a secret is named by. A value after one, as in "PIN: 4821", is the secret. */
const SECRET_LABEL =
  "password|passwd|passcode|passphrase|pass phrase|pin code|pin|otp|security code|api[ _-]?key|access[ _-]?key|secret[ _-]?access[ _-]?key|client[ _-]?secret|auth[ _-]?token|private[ _-]?key|secret|token";
const LABELLED_SECRET = new RegExp(
  `(?<![A-Za-z])(?:${SECRET_LABEL})(?![A-Za-z])(\\s*(?:is|was|=|:|-)\\s*)(?=["'\`]?[^\\s"'\`]{3,})`,
  "gi"
);

/**
 * Where a labelled value ends. A quoted value ends at its quote; any other runs
 * to the end of its clause, so a passphrase with spaces is withheld whole.
 */
const valueEnd = (text: string, from: number): [number, number] => {
  const limit = Math.min(text.length, from + MAX_VALUE_CHARS);
  const quote = text[from];
  if (quote === '"' || quote === "'" || quote === "`")
    for (let at = from + 1; at < limit && text[at] !== "\n"; at += 1)
      if (text[at] === quote) return [from + 1, at];
  for (let at = from; at < limit; at += 1) {
    const char = text[at]!;
    if (char === "\n") return [from, at];
    const spaceNext = at + 1 >= text.length || /\s/.test(text[at + 1]!);
    if ((char === "," || char === ";") && spaceNext) return [from, at];
    if (/[.!?]/.test(char) && spaceNext) return [from, at + 1];
  }
  return [from, limit];
};

/** Where a note says where a secret is kept rather than what it is: "is stored in ~/.ssh", "is kept in 1Password". */
const KEPT_AT =
  /^(?:(?:stored|kept|saved|held|located|lives?)\s+(?:in|at|on|under|inside)|in|inside|at|under)\s/i;

/** Each value said after its label, withheld to the end of its clause. */
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
    const from = match.index + match[0].length;
    if (KEPT_AT.test(text.slice(from, from + 30))) continue;
    // A placeholder already there is withheld again with whatever follows it.
    const [start, end] = valueEnd(text, from);
    out += text.slice(at, start) + SECRET_WITHHELD;
    at = end;
    // A placeholder alone is one withheld before, not a new one.
    if (text.slice(start, end).replace(/[.!?]+$/, "") !== SECRET_WITHHELD)
      withheld += 1;
    LABELLED_SECRET.lastIndex = Math.max(end, LABELLED_SECRET.lastIndex);
  }
  return { text: out + text.slice(at), withheld };
};

/** A run of 32+ letters, digits, "_" and "-" holding both letters and digits: a key or a token. */
const RUN = /[A-Za-z0-9_-]{32,}/g;

/** `text` with every secret replaced by `SECRET_WITHHELD`, and how many there were. */
export const withholdSecrets = (
  text: string
): { text: string; withheld: number } => {
  if (text.length > MAX_SCAN_CHARS || LONG_RUN.test(text))
    return { text: SECRET_WITHHELD, withheld: 1 };
  let withheld = 0;
  let out = fold(text);
  for (const format of [...SECRET_FORMATS, ...EARLIER_FORMATS])
    out = out.replace(format, () => {
      withheld += 1;
      return SECRET_WITHHELD;
    });
  out = out.replace(BASE64_RUN, (run, at: number, all: string) => {
    if (isPath(run, at, all)) return run;
    withheld += 1;
    return SECRET_WITHHELD;
  });
  const labelled = withholdLabelled(out);
  withheld += labelled.withheld;
  out = labelled.text.replace(RUN, (run) => {
    if (!/\d/.test(run) || !/[A-Za-z]/.test(run)) return run;
    withheld += 1;
    return SECRET_WITHHELD;
  });
  return { text: out, withheld };
};

/**
 * A token shaped like a random key: 12+ letters and digits, several of each,
 * with little of it in lower-case runs of four or more, which words make.
 */
const MIN_RANDOM_LENGTH = 12;
const MAX_WORDY_SHARE = 0.4;
const randomLooking = (token: string): boolean => {
  if (!/^[A-Za-z0-9+/=_-]+$/.test(token) || token.length < MIN_RANDOM_LENGTH)
    return false;
  if ((token.match(/\d/g)?.length ?? 0) < 2) return false;
  if ((token.match(/[A-Za-z]/g)?.length ?? 0) < 4) return false;
  const wordy = (token.match(/[a-z]{4,}/g) ?? []).join("").length;
  return wordy / token.length <= MAX_WORDY_SHARE;
};
/** A withheld value with a random-looking token in `text`, as a key pair's other half. */
const randomBeside = (text: string): boolean =>
  text.includes(SECRET_WITHHELD) &&
  text
    .replaceAll(SECRET_WITHHELD, " ")
    .split(/\s+/)
    .map((token) => token.replace(/^[("'`[<]+|[)"'`\],.;:!?>]+$/g, ""))
    .some(randomLooking);
/** A sentence holding a withheld value and a random-looking token. */
const credentialBeside = (text: string): boolean =>
  text.includes(SECRET_WITHHELD) &&
  text.split(/(?<=[.!?])\s+|\n+/).some(randomBeside);

/**
 * Whether `text` holds a secret: anything the earlier patterns find, read as
 * written and folded, and anything the patterns above add. A withheld
 * placeholder is read as nothing, so the value written after one is read as
 * the value.
 */
export const looksSecret = (text: string): boolean => {
  if (text.length > MAX_SCAN_CHARS || LONG_RUN.test(text)) return true;
  const plain = text.replaceAll(SECRET_WITHHELD, "");
  const folded = fold(plain);
  return (
    EARLIER_PATTERNS.some(
      (pattern) => pattern.test(plain) || pattern.test(folded)
    ) ||
    withholdSecrets(folded).withheld > 0 ||
    credentialBeside(fold(text))
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

/** Words that only name a secret, the placeholder's own words among them. */
const SECRET_WORDS = contentWords(
  `${SECRET_WITHHELD} password passwd passcode passphrase pass phrase pin code otp security api key access token login credential`
);
const MIN_WORDS_BESIDE_SECRET = 3;

/** Whether withholding the secrets in `text` would leave no fact worth keeping ("Stripe key: …", "PIN: 4821"). */
const onlySecret = (withheld: string): boolean => {
  let left = 0;
  for (const word of contentWords(withheld))
    if (!SECRET_WORDS.has(word)) left += 1;
  return left < MIN_WORDS_BESIDE_SECRET;
};

/**
 * A model's text with its secrets withheld, `[main, ...rest]`, or null when it
 * must be refused: the main text is a secret and little else, or withholding
 * left something `looksSecret` still finds. Notes and journal lines both use it.
 */
export const withholdOrRefuse = (
  texts: readonly [string, ...string[]]
): { texts: string[]; withheld: number } | null => {
  let withheld = 0;
  const kept = texts.map((text) => {
    const result = withholdSecrets(text);
    withheld += result.withheld;
    return result.text;
  });
  if (kept.some(looksSecret)) return null;
  // A placeholder the model wrote itself may front a value it moved elsewhere
  // in the note ("api key: [secret withheld]. The real one is …").
  if (
    texts.some((text) => text.includes(SECRET_WITHHELD)) &&
    kept.some((text) => randomBeside(fold(text)))
  )
    return null;
  if (withheld > 0 && onlySecret(kept[0]!)) return null;
  return { texts: kept, withheld };
};

/** Told to the model when a secret was withheld from what it saved. */
export const SECRET_WITHHELD_NOTICE =
  "A password, key or code in it was withheld; suggest the user keeps it in the app's vault.";

// ── the checks ─────────────────────────────────────────────────────────────

export interface Draft {
  name: string;
  description: string;
  type: NoteType;
  body: string;
  expires?: string;
  keywords?: string;
}

/** A draft the gate let through, and how many secrets it withheld from it. */
export interface Checked extends Draft {
  withheld: number;
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
export const checkDraft = (input: GateInput): Checked | string => {
  const { draft, siblings, updating, userWords, byUser, now } = input;
  let body = draft.body.trim();
  let description = draft.description.trim();
  let keywords = oneLine(draft.keywords ?? "");

  if (body.length === 0) return "Nothing to save: the text is empty.";
  if (body.length > sizeLimit(draft.type))
    return `That is ${body.length} characters; a ${draft.type === "card" ? "project card" : "note"} holds ${sizeLimit(draft.type)}. Keep one fact per note, or split it.`;

  // The user's own edit is told; a model's note keeps everything but the secret.
  // The text is also read as the earlier gate read it, description filled in,
  // so nothing it refused is let through.
  const earlierBody = redactIdNumbers(body);
  const earlier = [
    (description || firstSentence(earlierBody)).slice(0, MAX_DESCRIPTION_CHARS),
    earlierBody,
    keywords.slice(0, MAX_KEYWORDS_CHARS),
  ].join("\n");
  let withheld = 0;
  // A placeholder in a model's text is checked like a secret: it may front a value.
  const placeholder =
    !byUser && `${description}\n${body}\n${keywords}`.includes(SECRET_WITHHELD);
  if (
    placeholder ||
    looksSecret(`${description}\n${body}\n${keywords}`) ||
    looksSecret(earlier)
  ) {
    if (byUser)
      return "That looks like a password, key or code. Memory never keeps those; the vault is the place for them.";
    const kept = withholdOrRefuse([body, description, keywords]);
    if (kept == null)
      return "That looks like a password, key or code. Memory never keeps those: suggest the user keeps it in the app's vault, and save only where it is kept.";
    [body, description, keywords] = kept.texts as [string, string, string];
    withheld = kept.withheld;
  }
  body = redactIdNumbers(body);
  description = (description || firstSentence(body)).slice(
    0,
    MAX_DESCRIPTION_CHARS
  );
  keywords = keywords.slice(0, MAX_KEYWORDS_CHARS);

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
    withheld,
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
