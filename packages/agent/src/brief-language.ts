/**
 * The language a deck or document is written in follows the user's own words.
 * "AI पर ppt बनाओ" got an English deck: the chat decided Hinglish meant
 * English (hard asks, 20 Nov). A brief written mostly in Latin letters for a
 * user who wrote mostly in another script is sent back once, unless the user
 * asked for English.
 */

const SCRIPTS: Array<[string, RegExp]> = [
  ["Devanagari (Hindi, Marathi)", /[ऀ-ॿ]/gu],
  ["Bengali", /[ঀ-৿]/gu],
  ["Gurmukhi (Punjabi)", /[਀-੿]/gu],
  ["Gujarati", /[઀-૿]/gu],
  ["Tamil", /[஀-௿]/gu],
  ["Telugu", /[ఀ-౿]/gu],
  ["Kannada", /[ಀ-೿]/gu],
  ["Malayalam", /[ഀ-ൿ]/gu],
  ["Arabic", /[؀-ۿݐ-ݿ]/gu],
  ["Hebrew", /[֐-׿]/gu],
  ["Cyrillic", /[Ѐ-ӿ]/gu],
  ["Greek", /[Ͱ-Ͽ]/gu],
  ["Thai", /[฀-๿]/gu],
  ["CJK", /[぀-ヿ㐀-鿿가-힯]/gu],
];

const count = (text: string, re: RegExp): number =>
  (text.match(re) ?? []).length;

/** The script most of a text's letters are in, or null for Latin or none. */
export const mainScript = (text: string): string | null => {
  const latin = count(text, /[A-Za-zÀ-ɏ]/g);
  let best: [string, number] | null = null;
  for (const [name, re] of SCRIPTS) {
    const n = count(text, re);
    if (n > 0 && (best == null || n > best[1])) best = [name, n];
  }
  return best != null && best[1] > latin ? best[0] : null;
};

/** What to send back, or null when the brief's language follows the user's. */
export const briefLanguageProblem = (
  userWords: string,
  brief: string
): string | null => {
  const script = mainScript(userWords);
  if (script == null) return null;
  // The user asked for English, in any script.
  if (/\benglish\b|अंग्रेज़?ी|ஆங்கில|إنجليزي|انگریزی/i.test(userWords)) return null;
  if (mainScript(brief) != null) return null;
  return `Not made yet: the user wrote in ${script}, and this brief is written in Latin letters. Write the brief, and so the deck or document, in the user's language and script, unless they asked for another language; then call again.`;
};
