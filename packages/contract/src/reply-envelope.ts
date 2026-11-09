import { splitReasoning } from "@abacus-ai/agent/reasoning-tags";

// Literal tag matchers only: a lazy `[\s\S]*?` between two tags backtracks
// polynomially on model output (CodeQL js/polynomial-redos), so the blocks are
// found by scanning for the tags and slicing between them instead.
const REPLY_OPEN = /<reply>/gi;
const REPLY_CLOSE = /<\/reply>/gi;

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
    // The block opens at the last open tag before its close: an earlier one
    // is the model naming the tag in its narration ("I'll put it in <reply>
    // tags. Let me draft…"), and its words are not the reply.
    let start = opened;
    for (;;) {
      const next = indexOfTag(open, text, start[1]);
      if (next == null || next[0] >= closed[0]) break;
      start = next;
    }
    found.push({
      start: start[0],
      innerStart: start[1],
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

export const outgoingWords = (text: string): string => {
  const last = lastReplyBlock(text);
  return (last ?? splitReasoning(text).text).trim();
};

/** The last complete <reply> block in `text`, or null when there is none. */
export const lastTaggedReply = (text: string): string | null =>
  lastReplyBlock(text)?.trim() ?? null;
