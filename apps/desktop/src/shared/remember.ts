/**
 * Spots "remember I like blue" before the message reaches the model, so the
 * fact is stored whether or not the model calls its memory tool. Deliberately
 * narrow: it fires on being told to remember, not on the word appearing ("do
 * you remember the auth bug?" is a question). A missed ask can be repeated; a
 * false one lands in every future prompt, so when in doubt it stores nothing.
 */

/** Openers that count as an instruction. Anchored at the start of the ask. */
const OPENER =
  /^\s*(?:hey[,\s]+|ok(?:ay)?[,\s]+|and\s+|also[,\s]+|pls\s+|plz\s+|please\s+)*remember\b/i;

/** The connective an opener may carry before the fact itself. */
const CONNECTIVE = /^\s*(?:that|this|to|about|:|,|-|—)\s*/i;

/** Anything longer is a paste, not a fact worth carrying in every prompt. */
const MAX_FACT_CHARS = 500;

/**
 * The fact to store, or null. Only the first line counts: "remember X" over a
 * wall of pasted context is an instruction with a paste after it.
 */
export const detectRememberRequest = (message: string): string | null => {
  const firstLine = message.split("\n")[0] ?? "";
  // "Do you remember" fails the anchor; this covers "remember the auth bug?".
  if (firstLine.trim().endsWith("?")) return null;

  const opener = OPENER.exec(firstLine);
  if (opener == null) return null;

  const rest = firstLine.slice(opener[0].length).replace(CONNECTIVE, "").trim();
  // "remember" on its own is a word, not a fact.
  if (rest.length < 2 || rest.length > MAX_FACT_CHARS) return null;

  return rest;
};
