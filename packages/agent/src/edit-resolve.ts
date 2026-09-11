/**
 * Locating the text an edit means to replace. Models misquote indentation and
 * whitespace constantly, so matching is a cascade of strategies tried in
 * order; exact wins outright, relaxed ones run only on input that would
 * otherwise error. Adapted from opencode (MIT), but matches are index ranges
 * into the raw source and replacement is index splicing, never `replaceAll`.
 */

/** A matched span of the source, as a half-open index range. */
export interface MatchRange {
  start: number;
  end: number;
}

export type ResolveFailure =
  /** oldText was empty — the caller wants `write`, not `edit`. */
  | { kind: "empty" }
  /** oldText and newText are the same, so the edit is a no-op. */
  | { kind: "identical" }
  /** No strategy found the text at all. */
  | { kind: "not-found" }
  /** Found, but in more than one place, and replaceAll was not set. */
  | { kind: "ambiguous"; count: number; lines: number[] }
  /** A relaxed strategy matched a span far larger than what was asked for. */
  | {
      kind: "disproportionate";
      strategy: string;
      matchedLines: number;
      askedLines: number;
    };

export type ResolveResult =
  | { ok: true; ranges: MatchRange[]; strategy: StrategyName; relaxed: boolean }
  | { ok: false; failure: ResolveFailure };

export type StrategyName =
  | "exact"
  | "unicode-normalized"
  | "line-trimmed"
  | "block-anchor"
  | "whitespace-normalized"
  | "indentation-flexible"
  | "escape-normalized"
  | "trimmed-boundary"
  | "context-anchored";

/** A strategy yields candidate substrings of `content` that `find` might mean. */
type Strategy = (
  content: string,
  find: string
) => Generator<string, void, unknown>;

/** Every non-overlapping index of `search` in `content`. */
function allIndicesOf(content: string, search: string): number[] {
  const out: number[] = [];
  if (search === "") return out;

  let from = 0;
  for (;;) {
    const at = content.indexOf(search, from);
    if (at === -1) break;
    out.push(at);
    // Past the whole match: overlapping hits would splice into each other.
    from = at + search.length;
  }
  return out;
}

/** 1-based line number of a character offset, for error messages. */
export function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === "\n") line++;
  }
  return line;
}

// ── Strategies ───────────────────────────────────────────────────────────────
// Ordered loosest-last. The caller judges each candidate, so an ambiguous
// strategy falls through to the next rather than guessing.

/** The text, verbatim. */
const exact: Strategy = function* (_content, find) {
  yield find;
};

/**
 * Text that differs only in what copy-paste mangles: smart quotes, Unicode
 * dashes, exotic spaces, trailing whitespace. Mirrors pi's built-in edit tool.
 */
export function normalizeUnicode(text: string): string {
  return text
    .normalize("NFKC")
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
    .replace(/[\u201C\u201D\u201E\u201F]/g, '"')
    .replace(/[\u2010\u2011\u2012\u2013\u2014\u2015\u2212]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ");
}

const unicodeNormalized: Strategy = function* (content, find) {
  const target = normalizeUnicode(find);
  if (target === find) return;

  const contentLines = content.split("\n");
  const findLineCount = countRequestedLines(find);
  if (findLineCount === 0) return;

  for (let i = 0; i + findLineCount <= contentLines.length; i++) {
    const block = contentLines.slice(i, i + findLineCount).join("\n");
    if (normalizeUnicode(block) !== target) continue;
    const startOffset = offsetOfLine(content, i);
    yield content.slice(startOffset, startOffset + block.length);
  }
};

/**
 * Lines the request spans; a trailing newline's empty element does not count.
 */
function countRequestedLines(find: string): number {
  const lines = find.split("\n");
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines.length;
}

/** Same lines, ignoring each line's leading and trailing whitespace. */
const lineTrimmed: Strategy = function* (content, find) {
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  // A trailing newline's empty last element would never match a real line.
  if (findLines.length > 1 && findLines[findLines.length - 1] === "")
    findLines.pop();
  if (findLines.length === 0) return;

  for (let i = 0; i + findLines.length <= contentLines.length; i++) {
    let hit = true;
    for (let j = 0; j < findLines.length; j++) {
      if (contentLines[i + j]!.trim() !== findLines[j]!.trim()) {
        hit = false;
        break;
      }
    }
    if (!hit) continue;

    // Rebuild the exact source span so the caller splices real text.
    const startOffset = offsetOfLine(content, i);
    const endOffset = offsetOfLine(content, i + findLines.length) - 1;
    yield content.slice(startOffset, Math.max(startOffset, endOffset));
  }
};

/**
 * Character offset where each 0-based line starts, plus a one-past-the-end
 * entry. Cached against the source: several strategies scan every line, and
 * recounting newlines from the top each time made the cascade quadratic.
 */
let lineStartCache: { content: string; starts: number[] } | undefined;

function lineStarts(content: string): number[] {
  if (lineStartCache?.content === content) return lineStartCache.starts;

  const starts = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === "\n") starts.push(i + 1);
  }
  starts.push(content.length + 1);
  lineStartCache = { content, starts };

  return starts;
}

/** Character offset where a 0-based line starts. */
function offsetOfLine(content: string, line: number): number {
  const starts = lineStarts(content);
  if (line <= 0) return 0;

  return starts[line] ?? content.length + 1;
}

/**
 * First and last line as anchors, for blocks of three lines or more. Size may
 * drift within a quarter of the request and the middle must be mostly right;
 * an anchor pair alone would match from one `}` to an unrelated one.
 */
const blockAnchor: Strategy = function* (content, find) {
  const contentLines = content.split("\n");
  const findLines = find.split("\n");
  if (findLines.length > 1 && findLines[findLines.length - 1] === "")
    findLines.pop();
  if (findLines.length < 3) return;

  const firstAnchor = findLines[0]!.trim();
  const lastAnchor = findLines[findLines.length - 1]!.trim();
  const wanted = findLines.length;
  const maxDelta = Math.max(1, Math.floor(wanted * 0.25));

  const candidates: Array<{ start: number; end: number }> = [];
  for (let i = 0; i < contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstAnchor) continue;
    for (let j = i + 2; j < contentLines.length; j++) {
      if (contentLines[j]!.trim() !== lastAnchor) continue;
      if (Math.abs(j - i + 1 - wanted) <= maxDelta)
        candidates.push({ start: i, end: j });
      // Only the nearest closing anchor; a later one would span everything
      // between.
      break;
    }
  }

  for (const candidate of candidates) {
    const size = candidate.end - candidate.start + 1;
    const comparable = Math.min(wanted, size) - 2;
    if (comparable > 0) {
      let same = 0;
      for (let k = 1; k <= comparable; k++) {
        if (contentLines[candidate.start + k]!.trim() === findLines[k]!.trim())
          same++;
      }
      // A lone candidate gets more benefit of the doubt than one of several.
      const threshold = candidates.length === 1 ? 0.3 : 0.5;
      if (same / comparable < threshold) continue;
    }

    const startOffset = offsetOfLine(content, candidate.start);
    const endOffset = offsetOfLine(content, candidate.end + 1) - 1;
    yield content.slice(startOffset, Math.max(startOffset, endOffset));
  }
};

/** Same tokens, any whitespace between them. */
const whitespaceNormalized: Strategy = function* (content, find) {
  const normalize = (text: string) => text.replace(/\s+/g, " ").trim();
  const target = normalize(find);
  if (target === "") return;

  const contentLines = content.split("\n");
  const findLineCount = countRequestedLines(find);

  // Single line first, then blocks of the same height as the request.
  for (let i = 0; i < contentLines.length; i++) {
    if (normalize(contentLines[i]!) === target) {
      const startOffset = offsetOfLine(content, i);
      yield content.slice(startOffset, startOffset + contentLines[i]!.length);
    }
  }

  if (findLineCount < 2) return;
  for (let i = 0; i + findLineCount <= contentLines.length; i++) {
    const block = contentLines.slice(i, i + findLineCount).join("\n");
    if (normalize(block) !== target) continue;
    const startOffset = offsetOfLine(content, i);
    yield content.slice(startOffset, startOffset + block.length);
  }
};

/** Same block, uniformly shifted left or right. */
const indentationFlexible: Strategy = function* (content, find) {
  const dedent = (text: string) => {
    const lines = text.split("\n");
    const indents = lines
      .filter((l) => l.trim() !== "")
      .map((l) => l.length - l.trimStart().length);
    const common = indents.length > 0 ? Math.min(...indents) : 0;
    return lines
      .map((l) => (l.trim() === "" ? l.trim() : l.slice(common)))
      .join("\n");
  };

  const target = dedent(find);
  if (target.trim() === "") return;

  const contentLines = content.split("\n");
  const findLineCount = countRequestedLines(find);
  if (findLineCount === 0) return;

  for (let i = 0; i + findLineCount <= contentLines.length; i++) {
    const block = contentLines.slice(i, i + findLineCount).join("\n");
    if (dedent(block) !== target) continue;
    const startOffset = offsetOfLine(content, i);
    yield content.slice(startOffset, startOffset + block.length);
  }
};

/** Text whose escapes arrived doubled (a literal backslash-n for a newline). */
const escapeNormalized: Strategy = function* (content, find) {
  const unescape = (text: string) =>
    text
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\r/g, "\r")
      .replace(/\\'/g, "'")
      .replace(/\\"/g, '"')
      .replace(/\\`/g, "`")
      .replace(/\\\\/g, "\\");

  const target = unescape(find);
  if (target === find || target === "") return;
  if (content.includes(target)) yield target;
};

/** The block with its outer blank lines and edge whitespace trimmed off. */
const trimmedBoundary: Strategy = function* (content, find) {
  const trimmed = find.trim();
  if (trimmed === "" || trimmed === find) return;
  if (content.includes(trimmed)) yield trimmed;
};

/**
 * Anchors plus a majority of the middle, at exactly the requested height: the
 * last resort for a block whose interior the model paraphrased.
 */
const contextAnchored: Strategy = function* (content, find) {
  const findLines = find.split("\n");
  if (findLines.length > 1 && findLines[findLines.length - 1] === "")
    findLines.pop();
  if (findLines.length < 3) return;

  const contentLines = content.split("\n");
  const firstAnchor = findLines[0]!.trim();
  const lastAnchor = findLines[findLines.length - 1]!.trim();

  for (let i = 0; i + findLines.length <= contentLines.length; i++) {
    if (contentLines[i]!.trim() !== firstAnchor) continue;
    const end = i + findLines.length - 1;
    if (contentLines[end]!.trim() !== lastAnchor) continue;

    let matching = 0;
    let considered = 0;
    for (let k = 1; k < findLines.length - 1; k++) {
      const a = contentLines[i + k]!.trim();
      const b = findLines[k]!.trim();
      if (a.length === 0 && b.length === 0) continue;
      considered++;
      if (a === b) matching++;
    }
    if (considered > 0 && matching / considered < 0.5) continue;

    const startOffset = offsetOfLine(content, i);
    const endOffset = offsetOfLine(content, end + 1) - 1;
    yield content.slice(startOffset, Math.max(startOffset, endOffset));
  }
};

const STRATEGIES: Array<{ name: StrategyName; run: Strategy }> = [
  { name: "exact", run: exact },
  { name: "unicode-normalized", run: unicodeNormalized },
  { name: "line-trimmed", run: lineTrimmed },
  { name: "block-anchor", run: blockAnchor },
  { name: "whitespace-normalized", run: whitespaceNormalized },
  { name: "indentation-flexible", run: indentationFlexible },
  { name: "escape-normalized", run: escapeNormalized },
  { name: "trimmed-boundary", run: trimmedBoundary },
  { name: "context-anchored", run: contextAnchored },
];

/**
 * Whether a relaxed match swallowed far more than was asked for. Anchor
 * strategies can turn a `}`..`}` request into a two-hundred-line span; better
 * to refuse and make the model re-read than report a successful edit.
 */
function isDisproportionate(match: string, find: string): boolean {
  const askedLines = find.split("\n").length;
  const matchedLines = match.split("\n").length;
  if (matchedLines >= Math.max(askedLines + 3, askedLines * 2)) return true;
  if (askedLines === 1) return false;
  return (
    match.trim().length >
    Math.max(find.trim().length + 500, find.trim().length * 4)
  );
}

/**
 * Find the span(s) `oldText` refers to. Without `replaceAll`, a strategy that
 * finds several occurrences is not usable, so the cascade moves on and reports
 * ambiguity only if nothing later resolves cleanly.
 */
export function resolveEdit(
  content: string,
  oldText: string,
  newText: string,
  replaceAll: boolean
): ResolveResult {
  if (oldText === "") return { ok: false, failure: { kind: "empty" } };
  if (oldText === newText) return { ok: false, failure: { kind: "identical" } };

  let ambiguous: { count: number; lines: number[] } | undefined;

  for (const { name, run } of STRATEGIES) {
    for (const candidate of run(content, oldText)) {
      if (candidate === "") continue;
      const indices = allIndicesOf(content, candidate);
      if (indices.length === 0) continue;

      if (name !== "exact" && isDisproportionate(candidate, oldText)) {
        return {
          ok: false,
          failure: {
            kind: "disproportionate",
            strategy: name,
            matchedLines: candidate.split("\n").length,
            askedLines: oldText.split("\n").length,
          },
        };
      }

      if (indices.length > 1 && !replaceAll) {
        // Remember the first ambiguity for the error, but a later strategy may
        // still pin down one span.
        ambiguous ??= {
          count: indices.length,
          lines: indices.map((i) => lineOf(content, i)),
        };
        continue;
      }

      return {
        ok: true,
        ranges: indices.map((start) => ({
          start,
          end: start + candidate.length,
        })),
        strategy: name,
        relaxed: name !== "exact",
      };
    }
  }

  if (ambiguous)
    return { ok: false, failure: { kind: "ambiguous", ...ambiguous } };
  return { ok: false, failure: { kind: "not-found" } };
}

/**
 * Splice ranges into the source. Never `String.replace`: `$&` and `$1` in the
 * replacement are pattern syntax, so new text with a dollar sign would corrupt.
 */
export function spliceRanges(
  content: string,
  patches: ReadonlyArray<{ start: number; end: number; text: string }>
): string {
  const ordered = [...patches].sort((a, b) => a.start - b.start);
  let out = "";
  let cursor = 0;
  for (const patch of ordered) {
    if (patch.start < cursor) continue;
    out += content.slice(cursor, patch.start) + patch.text;
    cursor = patch.end;
  }
  return out + content.slice(cursor);
}
