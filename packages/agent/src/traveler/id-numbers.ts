/**
 * ID numbers kept out of free-text memory. Traveler details live in the
 * traveler store, saved only on the user's yes; a passport, national ID,
 * card or account number copied into a remembered fact or a day's log would
 * outlive that consent and travel with every prompt that recalls it.
 *
 * Patterns, by how sure they are:
 * - A number after its label ("passport K1234567", "Aadhaar: 1234 5678 9012",
 *   "PAN ABCDE1234F", "account no 00123456789").
 * - Shapes that are IDs on their own: an Indian PAN, a passport-style letter
 *   and 7-8 digits, nine digits alone (a US or UK passport, an SSN), a US
 *   SSN, and 12+ digits in groups of four (Aadhaar, a card number). A phone
 *   number (10 digits, or +country) and an amount are not.
 */

export const ID_NUMBER_WITHHELD = "[number withheld]";

const LABELS = [
  "passport(?:\\s+(?:no|number))?",
  "aadhaa?r(?:\\s+(?:no|number))?",
  "pan(?:\\s+card)?",
  "national\\s+id",
  "id\\s+(?:card|number|no)",
  "voter\\s+id",
  "driv(?:ing|er'?s?)\\s+licen[cs]e",
  "licen[cs]e\\s+(?:no|number)",
  "ssn",
  "social\\s+security(?:\\s+number)?",
  "account\\s+(?:no|number)",
  "a/c",
  "card\\s+(?:no|number)",
  "tax\\s+id",
].join("|");

/**
 * A label, a few joining words ("number is", "no.:"), then a value whose
 * first word has a digit (more digit groups may follow).
 */
const LABELLED = new RegExp(
  `\\b(${LABELS})((?:\\s*(?:no\\.?|number|num|#|is|was|reads|of|:|=|-))*\\s*)([A-Za-z]*\\d[A-Za-z0-9-]*(?:\\s\\d[\\d-]*)*)`,
  "gi"
);

const SHAPES: readonly RegExp[] = [
  // Indian PAN: five letters, four digits, a letter.
  /\b[A-Z]{5}\d{4}[A-Z]\b/g,
  // Passport style: one or two capitals and seven or eight digits.
  /\b[A-Z]{1,2}\d{7,8}\b/g,
  // US SSN.
  /\b\d{3}-\d{2}-\d{4}\b/g,
  // Nine digits on their own: a US or UK passport, an SSN without dashes.
  /(?<![\d+$₹£€.,])\b\d{9}\b(?![\d.,])/g,
  // 12 or more digits in groups of four: Aadhaar, a card number.
  /(?<![\d+])\b\d{4}[ -]?\d{4}[ -]?\d{4}(?:[ -]?\d{1,7})?\b(?!\d)/g,
];

/** `text` with every ID number replaced by `ID_NUMBER_WITHHELD`. */
export function redactIdNumbers(text: string): string {
  let out = text.replace(
    LABELLED,
    (_match, label: string, gap: string) =>
      `${label}${gap}${ID_NUMBER_WITHHELD}`
  );
  for (const shape of SHAPES) out = out.replace(shape, ID_NUMBER_WITHHELD);
  return out;
}
