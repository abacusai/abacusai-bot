// Literal tag matchers only: a lazy `[\s\S]*?` between two tags backtracks
// polynomially on model output (CodeQL js/polynomial-redos), so the blocks are
// found by scanning for the tags and slicing between them instead.
const REPLY_OPEN = /<reply>/gi;
const REPLY_CLOSE = /<\/reply>/gi;
const THINKING_OPEN = /<(?:thinking|think|reasoning)>/gi;
const THINKING_CLOSE = /<\/(?:thinking|think|reasoning)>/gi;

const indexOfTag = (
  pattern: RegExp,
  text: string,
  from: number
): [start: number, end: number] | null => {
  pattern.lastIndex = from;
  const match = pattern.exec(text);
  return match == null ? null : [match.index, match.index + match[0].length];
};

/** Every `open … close` block in `text`, non-overlapping, left to right. */
const blocks = (
  text: string,
  open: RegExp,
  close: RegExp
): Array<{
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}> => {
  const found = [];
  let from = 0;
  for (;;) {
    const opened = indexOfTag(open, text, from);
    if (opened == null) break;
    const closed = indexOfTag(close, text, opened[1]);
    if (closed == null) break;
    found.push({
      start: opened[0],
      innerStart: opened[1],
      innerEnd: closed[0],
      end: closed[1],
    });
    from = closed[1];
  }
  return found;
};

const lastReplyBlock = (text: string): string | null => {
  const last = blocks(text, REPLY_OPEN, REPLY_CLOSE).at(-1);
  return last == null ? null : text.slice(last.innerStart, last.innerEnd);
};

const withoutThinking = (text: string): string => {
  let kept = "";
  let from = 0;
  for (const block of blocks(text, THINKING_OPEN, THINKING_CLOSE)) {
    kept += text.slice(from, block.start);
    from = block.end;
  }
  return kept + text.slice(from);
};

export const outgoingWords = (text: string): string => {
  const last = lastReplyBlock(text);
  return (last ?? withoutThinking(text)).trim();
};

/** The last complete <reply> block in `text`, or null when there is none. */
export const lastTaggedReply = (text: string): string | null =>
  lastReplyBlock(text)?.trim() ?? null;
