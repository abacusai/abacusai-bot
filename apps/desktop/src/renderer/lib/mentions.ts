// Pure helpers for the composer's @file-mention and /command highlight overlay.

export const MENTION_CHAR = /[A-Za-z0-9_./-]/;
export const SLASH_CHAR = /[A-Za-z0-9_-]/;

export type TokenType = "text" | "mention" | "command";
export interface Token {
  type: TokenType;
  value: string;
}

/**
 * Split composer text into plain/@mention/slash-command tokens. The rules
 * mirror the real triggers so the overlay only colors what behaves as one:
 * `@` at start or after whitespace (emails stay plain); `/command` only when
 * the whole input is a single leading slash-word (paths stay plain).
 */
export function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let textStart = 0;
  let i = 0;

  const flushText = (end: number): void => {
    if (end > textStart)
      tokens.push({ type: "text", value: text.slice(textStart, end) });
  };

  // Same shape the composer uses to open the slash menu.
  if (text.startsWith("/") && !/\s/.test(text)) {
    let j = 1;
    while (j < text.length && SLASH_CHAR.test(text[j]!)) j++;
    if (j > 1) {
      tokens.push({ type: "command", value: text.slice(0, j) });
      textStart = j;
      i = j;
    }
  }

  while (i < text.length) {
    const ch = text[i]!;
    const atBoundary = i === 0 || /\s/.test(text[i - 1]!);

    if (ch === "@" && atBoundary) {
      if (text[i + 1] === '"') {
        const closingQuote = text.indexOf('"', i + 2);
        const end = closingQuote < 0 ? text.length : closingQuote + 1;
        flushText(i);
        tokens.push({ type: "mention", value: text.slice(i, end) });
        i = end;
        textStart = end;
        continue;
      }
      let j = i + 1;
      while (j < text.length && MENTION_CHAR.test(text[j]!)) j++;
      flushText(i);
      tokens.push({ type: "mention", value: text.slice(i, j) });
      i = j;
      textStart = j;
      continue;
    }

    i++;
  }
  flushText(text.length);

  return tokens;
}

export interface MentionMatch {
  query: string;
  startPos: number;
  endPos: number;
}

/** Keep a path with whitespace as one mention instead of splitting it at the first space. */
export const formatFileMention = (path: string): string =>
  /\s/.test(path) ? `@"${path.replaceAll('"', '\\"')}"` : `@${path}`;

/** Detect an @file-mention token straddling the cursor. Returns null when none is active. */
export function getMentionAtCursor(
  text: string,
  cursorPos: number
): MentionMatch | null {
  if (!text || cursorPos < 0) return null;

  const beforeCursor = text.slice(0, Math.min(cursorPos, text.length));
  const quotedStart = beforeCursor.lastIndexOf('@"');
  if (
    quotedStart >= 0 &&
    (quotedStart === 0 || /\s/.test(text[quotedStart - 1] ?? "")) &&
    !beforeCursor.slice(quotedStart + 2).includes('"')
  ) {
    const closingQuote = text.indexOf('"', quotedStart + 2);
    const endPos = closingQuote < 0 ? text.length : closingQuote + 1;
    return {
      query: text.slice(quotedStart + 2, Math.min(cursorPos, endPos)),
      startPos: quotedStart,
      endPos,
    };
  }

  let atIndex = -1;
  for (let i = Math.min(cursorPos, text.length) - 1; i >= 0; i--) {
    const ch = text[i];
    if (ch === "@") {
      atIndex = i;
      break;
    }
    if (!MENTION_CHAR.test(ch ?? "")) break;
  }
  if (atIndex === -1) return null;

  // Only trigger at start of text or after whitespace
  if (atIndex > 0) {
    const prev = text[atIndex - 1];
    if (prev && !/\s/.test(prev)) return null;
  }

  let endPos = atIndex + 1;
  while (endPos < text.length && MENTION_CHAR.test(text[endPos] ?? ""))
    endPos++;

  const typedEnd = Math.min(cursorPos, endPos);
  const query = text.slice(atIndex + 1, typedEnd);
  return { query, startPos: atIndex, endPos };
}
