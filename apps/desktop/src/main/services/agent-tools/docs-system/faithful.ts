/**
 * Numbers the brief does not support. Round 1 and the E smoke run printed
 * figures nobody gave: "$27.6M revenue", a date a month ahead, a quote number
 * "2026/114". A printed number passes if it is in the brief (however it is
 * grouped), was worked out by the code (sums and data-calc), is part of
 * today's date, or is a small counting number (list items, questions, page
 * numbers). A derivation the code did not compute does not pass: round 2
 * let "28% of ₹8.3 lakh is ₹7.7 lakh" through as a "simple derivation".
 */
const TOKEN = /\d[\d.,]*\d|\d/g;

/** The values a printed number can mean, read with either grouping convention. */
const values = (token: string): number[] => {
  const out = new Set<number>();
  const en = token.replace(/,(?=\d{3}(\D|$))/g, "");
  if (/^\d+(\.\d+)?$/.test(en)) out.add(Number(en));
  const pt = token.replace(/\.(?=\d{3}(\D|$))/g, "").replace(",", ".");
  if (/^\d+(\.\d+)?$/.test(pt)) out.add(Number(pt));
  if (out.size === 0) out.add(Number(token.replace(/\D/g, "")));
  return [...out];
};

const tokens = (text: string): string[] =>
  (
    text
      .normalize("NFKC")
      .replace(/[  ]/g, " ")
      .match(TOKEN) ?? []
  ).map((t) => t.replace(/[.,]$/, ""));

/** Every number the brief gives, read with either grouping convention. */
export const briefValues = (brief: string): number[] => [
  ...new Set(tokens(brief).flatMap(values)),
];

/**
 * The figures a brief gives, for the chart rule: each number once, read the
 * usual way, and no years (overnight: "480,000" also counted as 480, and
 * 2026 and 2027 counted, so a roadmap deck was asked for a chart).
 */
export const briefFigures = (brief: string): number[] => [
  ...new Set(
    tokens(brief)
      .map((t) => values(t)[0]!)
      .filter((v) => !(Number.isInteger(v) && v >= 1900 && v <= 2100))
  ),
];

const SMALL =
  "zero one two three four five six seven eight nine ten eleven twelve thirteen fourteen fifteen sixteen seventeen eighteen nineteen".split(
    " "
  );
const TENS = "twenty thirty forty fifty sixty seventy eighty ninety".split(" ");
const WORD = new RegExp(
  `\\b(?:(${TENS.join("|")})(?:[- ](${SMALL.slice(1, 10).join("|")}))?|(${SMALL.join("|")}))\\b`,
  "gi"
);

/** English number words ("seven", "twenty-five"), with where each ends. */
const numberWords = (
  text: string
): Array<{ raw: string; value: number; end: number }> =>
  [...text.matchAll(WORD)].map((m) => ({
    raw: m[0].toLowerCase(),
    value: m[3]
      ? SMALL.indexOf(m[3].toLowerCase())
      : 20 +
        10 * TENS.indexOf(m[1]!.toLowerCase()) +
        (m[2] ? SMALL.indexOf(m[2].toLowerCase()) : 0),
    end: m.index! + m[0].length,
  }));

/**
 * A number that measures something (7 years, two weeks, 6%) is checked even
 * when small: the counting-number pass is for lists and questions (overnight:
 * a CV's "seven years' experience" was the model's own sum).
 */
const MEASURES =
  /^\+?[\s'’]*(%|per ?cent\b|percent\b|(years?|months?|weeks?|days?|hours?)\b)/i;

export const unsupportedNumbers = (
  printed: string,
  ctx: { brief: string; computed: number[]; today: string }
): string[] => {
  const base = [
    ...tokens(ctx.brief).flatMap(values),
    ...numberWords(ctx.brief).map((w) => w.value),
  ];
  const allowed = new Set<number>([
    ...base,
    ...ctx.computed,
    ...tokens(ctx.today).flatMap(values),
  ]);
  const digitStrings = new Set(
    tokens(ctx.brief).map((t) => t.replace(/\D/g, ""))
  );
  // A year is given or not, never near: "2025" passed as close to today's
  // 2026 on a deck's cover ("Sürüm 1.0 · Ders içeriği · 2025").
  const close = (v: number): boolean =>
    allowed.has(v) ||
    (!(Number.isInteger(v) && v >= 1900 && v <= 2100) &&
      [...allowed].some(
        (a) =>
          Math.abs(a - v) <= 0.051 || (a > 100 && Math.abs(a - v) / a < 0.0005)
      ));

  const out: string[] = [];
  const text = printed.normalize("NFKC").replace(/[\u00a0\u202f]/g, " ");
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0].replace(/[.,]$/, "");
    const measures = MEASURES.test(text.slice(m.index! + m[0].length));
    for (const part of raw.split("/")) {
      if (part === "" || digitStrings.has(part.replace(/\D/g, ""))) continue;
      const vs = values(part);
      if (!measures && vs.some((v) => v <= 20 && Number.isInteger(v))) continue;
      if (vs.some(close)) continue;
      if (!out.includes(part)) out.push(part);
    }
  }
  for (const w of numberWords(text)) {
    const measures = MEASURES.test(text.slice(w.end));
    if ((w.value <= 20 && !measures) || close(w.value)) continue;
    if (!out.includes(w.raw)) out.push(w.raw);
  }
  return out;
};

/**
 * A share chart's given parts that the request does not give as percentages
 * (overnight: "31 households" drawn as a share printed "31%").
 */
export const sharesNotGiven = (parts: number[], facts: string): number[] => {
  const text = facts.normalize("NFKC");
  return parts.filter((v) => {
    const n = String(v).replace(".", "[.,]");
    return !new RegExp(`(?<![\\d.,])${n}\\s*(%|per ?cent|percent)`, "i").test(
      text
    );
  });
};

const DAYS = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];
const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];
const DAY = DAYS.join("|");
const MONTH = MONTHS.join("|");
/** "Tuesday 24 December", "Tuesday, 24 December 2026", "Tuesday, December 24, 2026". */
const DATED = new RegExp(
  `\\b(${DAY}),?\\s+(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MONTH})|(${MONTH})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?`,
  "gi"
);

/**
 * Weekdays that do not match their date. The memo in the 1.1.17 sanity said
 * "Tuesday 24 December" in 2026, a Thursday: the bot wrote 2024's weekdays.
 * A date without a year is the next one from today.
 */
export const wrongWeekdays = (text: string, today: string): string[] => {
  const now = new Date(today.replace(/^[A-Za-z]+,?\s*/, ""));
  if (Number.isNaN(now.getTime())) return [];
  const name = (word: string, list: string[]): number =>
    list.findIndex((item) => item.toLowerCase() === word.toLowerCase());
  const out: string[] = [];
  for (const m of text.normalize("NFKC").replace(/\s+/g, " ").matchAll(DATED)) {
    const month = name(m[3] ?? m[4]!, MONTHS);
    const day = Number(m[2] ?? m[5]);
    let year = m[6] != null ? Number(m[6]) : now.getFullYear();
    if (m[6] == null && new Date(year, month, day + 1) < now) year += 1;
    const date = new Date(year, month, day);
    if (date.getMonth() !== month) continue;
    const actual = DAYS[date.getDay()]!;
    if (actual.toLowerCase() !== m[1]!.toLowerCase())
      out.push(
        `"${m[0].trim()}" is wrong: ${day} ${MONTHS[month]} ${year} is a ${actual}.`
      );
  }
  return [...new Set(out)];
};
