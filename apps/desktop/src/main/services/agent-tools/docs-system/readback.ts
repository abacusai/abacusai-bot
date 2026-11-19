/**
 * Reading the printed file back. Round 1 handed over a deck whose eight PDF
 * slides were blank, as "ready". The printed text is compared with the text
 * the document was made from: every number must be there, and nearly every
 * word; a slide or page with nothing on it fails.
 */
import { pageBody } from "./fit";

export type Readback = {
  ok: boolean;
  wordsFound: number;
  wordsTotal: number;
  missingNumbers: string[];
  emptyPages: number[];
};

const norm = (s: string): string =>
  s
    .normalize("NFKC")
    .replace(/­/g, "")
    .replace(/[‐-―−]/g, "-")
    .toLowerCase();

/** Words of two letters or more, in any script. */
const words = (s: string): string[] =>
  norm(s).match(/[\p{L}\p{M}][\p{L}\p{M}'’]+/gu) ?? [];

/** Numbers as printed, without grouping, so "16.360,00" and "16,360.00" both read 1636000. A plain space ends a number. */
const numbers = (s: string): string[] =>
  (norm(s).match(/\d[\d.,\u00a0\u202f]*\d|\d/g) ?? []).map((n) =>
    n.replace(/[^\d]/g, "")
  );

export const readBack = (source: string, printedPages: string[]): Readback => {
  const printed = printedPages.join(" ");
  const have = new Map<string, number>();
  for (const w of words(printed)) have.set(w, (have.get(w) ?? 0) + 1);
  // Line breaks, hyphenation and letter-spacing split words in a PDF's text
  // layer ("C A N A L"): compare against all printed letters run together too.
  const joined = norm(printed).replace(/[^\p{L}\p{M}]/gu, "");
  // A script the text layer cannot be read back in (shaped Bengali prints
  // correctly but does not decode) is not counted; numbers still are.
  const scriptOf = (w: string): string =>
    /\p{Script=Latin}/u.test(w)
      ? "Latin"
      : /\p{Script=Bengali}/u.test(w)
        ? "Bengali"
        : /\p{Script=Devanagari}/u.test(w)
          ? "Devanagari"
          : /\p{Script=Cyrillic}/u.test(w)
            ? "Cyrillic"
            : /\p{Script=Greek}/u.test(w)
              ? "Greek"
              : "other";
  const printedScripts = new Set(words(printed).map(scriptOf));
  // Shaped scripts (Bengali, Devanagari…) decode from a PDF only in part, so
  // their words are not counted either way; numbers still are.
  const countable = new Set(["Latin", "Cyrillic", "Greek"]);
  const want = words(source).filter(
    (w) => countable.has(scriptOf(w)) && printedScripts.has(scriptOf(w))
  );
  let found = 0;
  for (const w of want) {
    const n = have.get(w) ?? 0;
    if (n > 0) {
      have.set(w, n - 1);
      found++;
    } else if (joined.includes(w.replace(/['’]/g, ""))) found++;
  }
  const printedNumbers = new Set(numbers(printed));
  // Letter-spaced numbers print as "2 0 2 6": all printed digits run together too.
  const printedDigits = norm(printed).replace(/\D/g, "");
  const missingNumbers = [...new Set(numbers(source))].filter(
    (n) => n.length > 0 && !printedNumbers.has(n) && !printedDigits.includes(n)
  );
  const emptyPages = printedPages
    .map((p, i) => ({
      i: i + 1,
      // Letters and digits, so letter-spaced capitals count.
      n: (norm(pageBody(p)).match(/[\p{L}\p{M}\d]/gu) ?? []).length,
    }))
    .filter((p) => p.n < 2)
    .map((p) => p.i);
  const ratio = want.length === 0 ? 1 : found / want.length;
  return {
    ok: ratio >= 0.97 && missingNumbers.length === 0 && emptyPages.length === 0,
    wordsFound: found,
    wordsTotal: want.length,
    missingNumbers,
    emptyPages,
  };
};
