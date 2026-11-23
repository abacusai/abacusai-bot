/**
 * Template stand-ins that must never print: "[Month, Year]", "[N]",
 * "[research@org.com]", "Lorem ipsum", "Your Name Here". A bracketed aside
 * counts only when it reads as a stand-in (a capital, an @ or a #): "[1]" is
 * a citation and "[year on year]" is the writer's own.
 */
const BRACKETED = /\[([^[\]\n]{1,48})\]/g;
const PHRASES =
  /\b(?:lorem ipsum|placeholder|tbc|tbd|xx+|(?:your|company|client|studio|presenter|app|founder|product|brand|startup) name(?: here)?)\b/gi;
/** "X%", "XX users", "Email: ____": a figure or field left for later. */
const STANDINS =
  /\([^()]{0,200}\bto be (?:confirmed|added|filled(?: in)?|gathered|provided|decided|announced)\b[^()]*\)|(?<![\w])X{1,3}%|_{3,}|^\s*(?:item|exhibition|speaker|event|feature|session|talk|name|title)\s+\d{1,2}(?:\s*$|\s+[—–-].*$)|\b(?:title|name)\s*\/\s*(?:artist|author|speaker|date|role|venue)\b|(?:\ba\s+)?\b(?:a|one)[ -](?:line|short|brief)\s+(?:note|description|line)\b[^.]*\.?/gim;

export const placeholdersIn = (text: string): string[] => {
  const found: Array<{ at: number; text: string }> = [];

  for (const match of text.matchAll(BRACKETED)) {
    const inner = match[1]!;
    if (inner.trim().toLowerCase() === "remove") continue;
    // "[place]", "[company name]": a short lowercase stand-in counts too.
    // So does one in a script without capitals ("[आपका नाम]" printed on a
    // Hindi cover) and a mark with no words at all ("[•]", "[…]", "[ ]").
    if (
      /[A-Z@#]/.test(inner) ||
      /[^\p{Script=Latin}\p{Script=Common}\p{Script=Inherited}]/u.test(inner) ||
      !/[\p{L}\p{N}]/u.test(inner) ||
      (/^[a-z][a-z ]{1,24}$/.test(inner.trim()) &&
        inner.trim().split(/\s+/).length <= 2 &&
        !/^(sic|sic\.|note|aside)$/.test(inner.trim()))
    )
      found.push({ at: match.index, text: match[0] });
  }
  for (const match of text.matchAll(PHRASES))
    found.push({ at: match.index, text: match[0] });
  for (const match of text.matchAll(STANDINS))
    found.push({ at: match.index, text: match[0] });

  return found.sort((a, b) => a.at - b.at).map((each) => each.text);
};

/** The text with its stand-ins taken out, and the separators they leave. */
export const withoutPlaceholders = (text: string): string => {
  let out = text;
  for (const each of placeholdersIn(text)) out = out.split(each).join("");
  return out
    .replace(/\s*([·•|,/–—-])\s*(?=\1|$)/g, "")
    .replace(/^\s*[·•|,/–—:-]\s*/, "")
    .replace(/^\s*:\s*$/, "")
    .replace(/\s{2,}/g, " ")
    .replace(/\s+([.,;:!?])/g, "$1")
    .trim();
};
