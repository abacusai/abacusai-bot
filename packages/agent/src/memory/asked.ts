/**
 * Whether the user asked, in their own words, for something to be kept:
 * "remember I like blue", "from now on, reply in short lines". Used only to
 * check that a save happened, never to save anything itself.
 */

const ASK =
  /^\s*(?:hey[,\s]+|ok(?:ay)?[,\s]+|and\s+|also[,\s]+|pls\s+|plz\s+|please\s+)*(?:remember|don['’]?t forget|keep in mind|note that|from now on)\b/i;

/** The first line of the user's own words asks to keep something. */
export const askedToRemember = (ownWords: string): boolean => {
  const firstLine = ownWords.split("\n")[0] ?? "";
  // "Do you remember the auth bug?" is a question, not an ask.
  if (firstLine.trim().endsWith("?")) return false;
  return ASK.test(firstLine);
};
