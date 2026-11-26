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
// Two jobs. `looksSecret` detects: it runs the patterns the gate has always
// refused on, unchanged in what they match, and adds to them; refusals, the
// Memory page, the handover and the migration all use it. `withholdSecrets`
// redacts: a model's note is kept with its secrets withheld only when
// `looksSecret` finds nothing left in the result.

/**
 * Stands where a secret was. The space after "[" keeps it from reading as a
 * value to the earlier patterns ("PIN: [ secret withheld ]" is not a PIN).
 */
export const SECRET_WITHHELD = "[ secret withheld ]";
/** Past this a text is treated as secret without reading it: notes are far shorter. */
const MAX_SCAN_CHARS = 100_000;
/** The longest value read after a label such as "password:". */
const MAX_VALUE_CHARS = 300;

/** Characters that show nothing, so a key split by one still reads as one. */
const INVISIBLE = /\p{Default_Ignorable_Code_Point}/u;
/** Dashes that stand in for "-". */
const DASH = /[‐-―−﹘﹣－]/u;

/**
 * Text as the checks read it, one character at a time: compatibility forms
 * folded (full-width letters, "："), dashes made "-", invisible characters
 * dropped. `from[i]` is where folded character `i` came from in `text`, so a
 * span found in the folded text can be withheld from the text as written.
 */
const fold = (text: string): { text: string; from: number[] } => {
  let out = "";
  const from: number[] = [];
  let at = 0;
  for (const char of text) {
    const folded = INVISIBLE.test(char)
      ? ""
      : DASH.test(char)
        ? "-"
        : char.normalize("NFKC");
    for (let i = 0; i < folded.length; i += 1) from.push(at);
    out += folded;
    at += char.length;
  }
  from.push(at);
  return { text: out, from };
};
const folded = (text: string): string => fold(text).text;

/**
 * The patterns the gate has always refused on. Two are read run by run
 * (`EARLIER_RUN`, `jwtSpans`): the same matches, without rescanning a long run
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
/** As /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g: three dot-joined runs, the first ending in "eyJ" and 10+ more. */
const EARLIER_JWT_START = /\beyJ[A-Za-z0-9_-]{10,}$/;
const jwtSpans = (text: string): Span[] => {
  const spans: Span[] = [];
  const runs = [...text.matchAll(/[A-Za-z0-9_-]+/g)];
  for (let i = 0; i + 2 < runs.length; i += 1) {
    const [first, second, third] = [runs[i]!, runs[i + 1]!, runs[i + 2]!];
    const firstEnd = first.index + first[0].length;
    const secondEnd = second.index + second[0].length;
    if (
      text[firstEnd] !== "." ||
      second.index !== firstEnd + 1 ||
      second[0].length < 10 ||
      text[secondEnd] !== "." ||
      third.index !== secondEnd + 1 ||
      third[0].length < 5
    )
      continue;
    const at = first[0].search(EARLIER_JWT_START);
    if (at < 0) continue;
    spans.push([first.index + at, third.index + third[0].length]);
    i += 2;
  }
  return spans;
};
const earlierFinds = (text: string): boolean =>
  EARLIER_PATTERNS.some((pattern) => pattern.test(text)) ||
  jwtSpans(text).length > 0 ||
  (text.match(/[A-Za-z0-9_-]{32,}/g) ?? []).some(
    (run) => /\d/.test(run) && /[A-Za-z]/.test(run) && EARLIER_RUN.test(run)
  );

/** Where a word starts, as `\b` before a word character. */
const RUN_START = "(?<![A-Za-z0-9_])";

/** Formats issued by known providers, and key material: withheld whole. */
const SECRET_FORMATS: RegExp[] = [
  ...EARLIER_PATTERNS.slice(0, 8).map((pattern) => pattern.source),
  `${RUN_START}(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}`,
  `${RUN_START}glpat-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}xapp-\\d-[A-Za-z0-9-]{10,}`,
  `${RUN_START}AKIA[0-9A-Z]{16}(?![0-9A-Z])`,
  `${RUN_START}GOCSPX-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}ya29\\.[A-Za-z0-9._-]{20,}`,
  `(?<![A-Za-z0-9/])1//0[A-Za-z0-9_-]{20,}`,
  `${RUN_START}SG\\.(?=(?<s>[A-Za-z0-9_-]{16,}))\\k<s>\\.[A-Za-z0-9_-]{16,}`,
  `${RUN_START}(?:whsec|npm|hf|shpat|shpss|shpca|dop_v1|glsa|pypi)_[A-Za-z0-9_-]{20,}`,
  `${RUN_START}sq0(?:atp|csp)-[A-Za-z0-9_-]{20,}`,
  `${RUN_START}\\d{8,10}:AA[A-Za-z0-9_-]{30,}`,
  `(?<![A-Za-z0-9_-])[MNO][A-Za-z0-9_-]{23,}\\.[A-Za-z0-9_-]{6}\\.[A-Za-z0-9_-]{27,}`,
  `AccountKey=[A-Za-z0-9+/]{20,}={0,2}`,
  // Webhook URLs whose path is the credential.
  `(?<=hooks\\.slack\\.com/services/)[A-Za-z0-9/]{20,}`,
  `(?<=maker\\.ifttt\\.com/[^\\s]{0,100}/key/)[A-Za-z0-9_-]{16,}`,
  `-----BEGIN [A-Z ]*PRIVATE KEY(?: BLOCK)?-----[\\s\\S]*?(?:-----END [A-Z ]*PRIVATE KEY(?: BLOCK)?-----|$)`,
].map((source) => new RegExp(source, source.includes("bearer") ? "gi" : "g"));

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
 * A run that names a file or folder: it goes on to an extension
 * (".../index.tsx"), starts at a root ("/", "~/", "./"), or is three or more
 * folder names ("Clients/Acme/Contracts").
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
  return parts.length >= 3 && parts.every((part) => FOLDER.test(part));
};

/** Words a secret is named by. A value after one, as in "PIN: 4821", is the secret. */
const SECRET_LABEL =
  "password|passwd|passcode|passphrase|pass phrase|pin code|pin|otp|security code|api[ _-]?key|access[ _-]?key|secret[ _-]?access[ _-]?key|client[ _-]?secret|auth[ _-]?token|private[ _-]?key|secret|token";
/** Labels the earlier patterns did not have: a dash after one is prose ("the private key - ed25519 - is …"). */
const ADDED_LABEL =
  /^(?:secret[ _-]?access[ _-]?key|client[ _-]?secret|auth[ _-]?token|private[ _-]?key)$/i;
const LABELLED_SECRET = new RegExp(
  `(?<![A-Za-z])(${SECRET_LABEL})(?![A-Za-z])(\\s*(?:is|was|=|:|-)\\s*)(?=["'\`]?[^\\s"'\`]{3,}|${SECRET_WITHHELD.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})`,
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
    // The full stop stays: it ends the sentence, not the value.
    if (/[.!?]/.test(char) && spaceNext) return [from, at];
  }
  return [from, limit];
};

/** Where a note says where a secret is kept rather than what it is: "is stored in ~/.ssh", "is in the .env file". */
const KEPT_AT =
  /^(?:(?:stored|kept|saved|held|located|lives?)\s+(?:in|at|on|under|inside)|in|inside|at|under)\s/i;

type Span = [number, number];

/** A token shaped like a credential: a digit, a symbol inside it, or a case change inside it. */
const CREDENTIAL_SHAPED =
  /\d|\p{L}[^\p{L}\p{N}\s.,;:!?)'’-]|[^\p{L}\p{N}\s("'`[’-]\p{L}|\p{Ll}\p{Lu}/u;

/** Each value said after its label, to the end of its clause. A placeholder alone is not a new one. */
const labelledSpans = (text: string): { spans: Span[]; found: number } => {
  const spans: Span[] = [];
  let found = 0;
  LABELLED_SECRET.lastIndex = 0;
  for (
    let match = LABELLED_SECRET.exec(text);
    match != null;
    match = LABELLED_SECRET.exec(text)
  ) {
    const from = match.index + match[0].length;
    if (ADDED_LABEL.test(match[1]!) && match[2]!.includes("-")) continue;
    if (KEPT_AT.test(text.slice(from, from + 30))) continue;
    const span = valueEnd(text, from);
    // A placeholder already there stays one. What follows it in the clause is
    // a new value only when it is shaped like one ("[ … ] hunter2"); words
    // ("[ … ] Updated on Friday") are the note going on.
    if (text.startsWith(SECRET_WITHHELD, from)) {
      const after = text.slice(from + SECRET_WITHHELD.length, span[1]);
      const next = after.trim().split(/\s+/)[0] ?? "";
      if (!CREDENTIAL_SHAPED.test(next)) {
        spans.push([from, from + SECRET_WITHHELD.length]);
        LABELLED_SECRET.lastIndex = Math.max(
          from + SECRET_WITHHELD.length,
          LABELLED_SECRET.lastIndex
        );
        continue;
      }
    }
    // A value on the line after its label is withheld from the line break, so
    // the placeholder stays on the label's line ("password:[ secret withheld ]").
    const lineBreak = match[2]!.indexOf("\n");
    spans.push(
      lineBreak < 0
        ? span
        : [match.index + match[1]!.length + lineBreak, span[1]]
    );
    found += 1;
    LABELLED_SECRET.lastIndex = Math.max(span[1], LABELLED_SECRET.lastIndex);
  }
  return { spans, found };
};

/** A run of 32+ letters, digits, "_" and "-" holding both letters and digits: a key or a token. */
const RUN = /[A-Za-z0-9_-]{32,}/g;

/**
 * Text with spans withheld: `view` shows each span as one placeholder, and
 * `toText` maps a position in `view` back to `text`.
 */
const render = (text: string, spans: readonly Span[]) => {
  let view = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let at = 0;
  const push = (start: number, end: number, piece: string) => {
    for (let i = 0; i < piece.length; i += 1) {
      starts.push(start === end ? start : start + i);
      ends.push(start === end ? end : start + i + 1);
    }
    view += piece;
  };
  for (const [start, end] of spans) {
    if (start > at) push(at, start, text.slice(at, start));
    starts.push(start);
    ends.push(end);
    for (let i = 1; i < SECRET_WITHHELD.length; i += 1) {
      starts.push(start);
      ends.push(end);
    }
    view += SECRET_WITHHELD;
    at = end;
  }
  if (at < text.length) push(at, text.length, text.slice(at));
  return {
    view,
    toText: ([start, end]: Span): Span => [
      start < starts.length ? starts[start]! : text.length,
      end > 0 ? ends[end - 1]! : 0,
    ],
  };
};

/** Spans merged in order, overlapping ones joined. */
const merge = (spans: Span[]): Span[] => {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  const out: Span[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last != null && span[0] <= last[1])
      last[1] = Math.max(last[1], span[1]);
    else out.push([...span]);
  }
  return out;
};

/**
 * `text` with every secret replaced by `SECRET_WITHHELD`, and how many there
 * were. The secrets are found in the folded text and withheld from the text as
 * written, which is otherwise kept as it was.
 */
export const withholdSecrets = (
  text: string
): { text: string; withheld: number } => {
  if (text.length > MAX_SCAN_CHARS)
    return { text: SECRET_WITHHELD, withheld: 1 };
  const read = fold(text);
  let spans: Span[] = [];
  let withheld = 0;
  let shown = render(read.text, spans);
  const pass = (find: (view: string) => { spans: Span[]; found: number }) => {
    const result = find(shown.view);
    withheld += result.found;
    if (result.spans.length === 0) return;
    spans = merge([...spans, ...result.spans.map(shown.toText)]);
    shown = render(read.text, spans);
  };
  const matches =
    (
      pattern: RegExp,
      keep?: (run: string, at: number, view: string) => boolean
    ) =>
    (view: string) => {
      const found: Span[] = [];
      for (const match of view.matchAll(pattern))
        if (keep == null || !keep(match[0], match.index, view))
          found.push([match.index, match.index + match[0].length]);
      return { spans: found, found: found.length };
    };
  for (const format of SECRET_FORMATS) pass(matches(format));
  pass((view) => {
    const found = jwtSpans(view);
    return { spans: found, found: found.length };
  });
  pass(matches(BASE64_RUN, isPath));
  pass(labelledSpans);
  pass(matches(RUN, (run) => !/\d/.test(run) || !/[A-Za-z]/.test(run)));
  if (spans.length === 0) return { text, withheld: 0 };
  let out = "";
  let at = 0;
  for (const [start, end] of spans) {
    const from = read.from[start]!;
    out += text.slice(at, from) + SECRET_WITHHELD;
    at = read.from[end]!;
  }
  return { text: out + text.slice(at), withheld };
};

/**
 * A token shaped like a random key: 12+ letters and digits, several of each,
 * with little of it in lower-case runs of four or more, which words make.
 */
const MIN_RANDOM_LENGTH = 12;
const MAX_WORDY_SHARE = 0.4;
const KEY_TOKEN = /^[A-Za-z0-9+/=_-]+$/;
const randomLooking = (token: string): boolean => {
  if (!KEY_TOKEN.test(token) || token.length < MIN_RANDOM_LENGTH) return false;
  if ((token.match(/\d/g)?.length ?? 0) < 2) return false;
  if ((token.match(/[A-Za-z]/g)?.length ?? 0) < 4) return false;
  // Mixed case, as base64 and base62 keys have, or a long hex string. A code
  // in capitals and digits ("RT-AX88U2024", "ABC123DEF456") is a product or a plate.
  if (
    !(/[a-z]/.test(token) && /[A-Z]/.test(token)) &&
    !/^[0-9a-f]{16,}$/i.test(token)
  )
    return false;
  const wordy = (token.match(/[a-z]{4,}/g) ?? []).join("").length;
  return wordy / token.length <= MAX_WORDY_SHARE;
};
/** A key's tail wrapped onto the next line: 12+ characters mixing letters and digits. */
const keyTail = (token: string): boolean =>
  KEY_TOKEN.test(token) &&
  token.length >= MIN_RANDOM_LENGTH &&
  /\d/.test(token) &&
  /[A-Za-z]/.test(token);
const tokensOf = (text: string): string[] =>
  text
    .split(/\s+/)
    .map((token) => token.replace(/^[("'`[<]+|[)"'`\],.;:!?>]+$/g, ""));
/**
 * A withheld value with another half of a key beside it: a random-looking
 * token anywhere in the text (a key pair, or a value moved past a placeholder
 * the model wrote), or a key-shaped token on the line after (a wrapped key).
 */
const credentialBeside = (text: string): boolean => {
  if (!text.includes(SECRET_WITHHELD)) return false;
  if (tokensOf(text.replaceAll(SECRET_WITHHELD, " ")).some(randomLooking))
    return true;
  const lines = text.split("\n");
  return lines.some(
    (line, at) =>
      line.includes(SECRET_WITHHELD) &&
      at + 1 < lines.length &&
      tokensOf(lines[at + 1]!).some(keyTail)
  );
};

/**
 * Whether `text` holds a secret: anything the earlier patterns find, read as
 * written and folded, anything the patterns above add, and a withheld value
 * with another half beside it. The earlier patterns never read a placeholder
 * as a value, and a value written after one in its clause is read as new.
 */
export const looksSecret = (text: string): boolean => {
  if (text.length > MAX_SCAN_CHARS) return true;
  const read = folded(text);
  return (
    earlierFinds(text) ||
    earlierFinds(read) ||
    withholdSecrets(read).withheld > 0 ||
    credentialBeside(read)
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
  // ID numbers first, as the gate always did: secrets are then read in the text it read.
  let body = redactIdNumbers(draft.body.trim());
  let description = draft.description.trim();
  let keywords = oneLine(draft.keywords ?? "");

  if (body.length === 0) return "Nothing to save: the text is empty.";
  if (body.length > sizeLimit(draft.type))
    return `That is ${body.length} characters; a ${draft.type === "card" ? "project card" : "note"} holds ${sizeLimit(draft.type)}. Keep one fact per note, or split it.`;

  // The user's own edit is told; a model's note keeps everything but the secret.
  // The text is also read as the earlier gate read it, description filled in,
  // so nothing it refused is let through.
  const earlier = [
    (description || firstSentence(body)).slice(0, MAX_DESCRIPTION_CHARS),
    body,
    keywords.slice(0, MAX_KEYWORDS_CHARS),
    // A blank line between the parts: no line of one reads as following another.
  ].join("\n\n");
  let withheld = 0;
  // A placeholder in a model's text is checked like a secret: it may front a value.
  const placeholder =
    !byUser && `${description}\n${body}\n${keywords}`.includes(SECRET_WITHHELD);
  if (
    placeholder ||
    looksSecret(`${description}\n\n${body}\n\n${keywords}`) ||
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
