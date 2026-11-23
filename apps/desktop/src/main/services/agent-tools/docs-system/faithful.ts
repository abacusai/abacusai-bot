/**
 * Numbers the brief does not support. Round 1 and the E smoke run printed
 * figures nobody gave: "$27.6M revenue", a date a month ahead, a quote number
 * "2026/114". A printed number passes if it is in the brief (however it is
 * grouped), was worked out by the code (sums and data-calc), is part of
 * today's date, or is a small counting number (list items, questions, page
 * numbers). A derivation the code did not compute does not pass: round 2
 * let "28% of ₹8.3 lakh is ₹7.7 lakh" through as a "simple derivation".
 */
/** Where the facts turn to what the bot read: the same mark as request-facts.ts. */
const READ_MARK = "\n\n\u2063read\u2063\n\n";

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

/**
 * Amounts in words ("Fifty-Three Thousand Six Hundred and Ninety"), each as one
 * number with where it starts and ends: read word by word, an invoice's
 * amount in words was "fifty-three" and "ninety", neither of them given.
 */
const SCALES: Record<string, number> = {
  hundred: 100,
  thousand: 1_000,
  lakh: 100_000,
  lakhs: 100_000,
  million: 1_000_000,
  crore: 10_000_000,
  crores: 10_000_000,
};
const amountsInWords = (
  text: string
): Array<{ value: number; start: number; end: number }> => {
  const word = `(?:${[...TENS, ...SMALL, ...Object.keys(SCALES)].join("|")})`;
  const phrase = new RegExp(
    `\\b${word}(?:(?:[\\s-]+|\\s+and\\s+)${word})*\\b`,
    "gi"
  );
  const out: Array<{ value: number; start: number; end: number }> = [];
  for (const m of text.matchAll(phrase)) {
    const parts = m[0]
      .toLowerCase()
      .split(/[\s-]+/)
      .filter((w) => w !== "and");
    if (!parts.some((w) => w in SCALES)) continue;
    let total = 0;
    let current = 0;
    for (const w of parts) {
      if (SMALL.includes(w)) current += SMALL.indexOf(w);
      else if (TENS.includes(w)) current += 20 + 10 * TENS.indexOf(w);
      else if (w === "hundred") current = (current || 1) * 100;
      else {
        total += (current || 1) * SCALES[w]!;
        current = 0;
      }
    }
    out.push({
      value: total + current,
      start: m.index!,
      end: m.index! + m[0].length,
    });
  }
  return out;
};

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

/**
 * Clock times a schedule works out from the request: a start it gives plus
 * durations it gives (a timetable "starting 8:30", "45 minutes", "a 20-minute
 * break" lost its whole row of period times as numbers nobody gave).
 */
const scheduleTimes = (given: string): Set<string> => {
  const starts = [...given.matchAll(/\b(\d{1,2})[:.](\d{2})\b/g)].map(
    (m) => Number(m[1]) * 60 + Number(m[2])
  );
  const steps = [
    ...new Set(
      [...given.matchAll(/\b(\d{1,3})[\s-]*(?:min|mins|minutes?)\b/gi)].map(
        (m) => Number(m[1])
      )
    ),
  ].filter((d) => d > 0 && d <= 240);
  const out = new Set<string>();
  const add = (t: number): void => {
    const h = Math.floor(t / 60) % 24;
    const m = t % 60;
    for (const hh of [h, h > 12 ? h - 12 : h])
      out.add(`${hh}:${String(m).padStart(2, "0")}`);
  };
  for (const start of starts) {
    add(start);
    // Up to 12 of the first step and 3 of each other, as a day's periods.
    const [first, ...rest] = steps;
    if (first == null) continue;
    for (let a = 0; a <= 12; a++)
      for (let b = 0; b <= 3; b++)
        for (const other of rest.length > 0 ? rest : [0])
          add(start + a * first + b * other);
  }
  return out;
};

export const unsupportedNumbers = (
  printed: string,
  ctx: { brief: string; computed: number[]; today: string; figure?: boolean }
): string[] => {
  // The facts end with what the bot read, after READ_MARK (request-facts.ts):
  // a number from there counts only as written, never as near one.
  const [given = "", read = ""] = ctx.brief.split(READ_MARK);
  const base = [
    ...tokens(given).flatMap(values),
    ...numberWords(given).map((w) => w.value),
  ];
  const exact = new Set<number>([
    ...tokens(read).flatMap(values),
    ...numberWords(read).map((w) => w.value),
  ]);
  const allowed = new Set<number>([
    ...base,
    ...ctx.computed,
    ...tokens(ctx.today).flatMap(values),
  ]);
  const digitStrings = new Set(tokens(given).map((t) => t.replace(/\D/g, "")));
  // A year is given or not, never near: "2025" passed as close to today's
  // 2026 on a deck's cover ("Sürüm 1.0 · Ders içeriği · 2025").
  const close = (v: number): boolean =>
    allowed.has(v) ||
    exact.has(v) ||
    (!(Number.isInteger(v) && v >= 1900 && v <= 2100) &&
      [...allowed].some(
        (a) =>
          Math.abs(a - v) <= 0.051 || (a > 100 && Math.abs(a - v) / a < 0.0005)
      ));

  const out: string[] = [];
  // Times a schedule works out from the request's own start and durations.
  const times = scheduleTimes(given);
  const text = printed
    .normalize("NFKC")
    .replace(/[\u00a0\u202f]/g, " ")
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (all, h: string, m: string) =>
      times.has(`${Number(h)}:${m}`) ? " " : all
    );
  for (const m of text.matchAll(TOKEN)) {
    const raw = m[0].replace(/[.,]$/, "");
    const measures = MEASURES.test(text.slice(m.index! + m[0].length));
    for (const part of raw.split("/")) {
      if (part === "" || digitStrings.has(part.replace(/\D/g, ""))) continue;
      const vs = values(part);
      if (
        !measures &&
        ctx.figure !== true &&
        vs.some((v) => v <= 20 && Number.isInteger(v))
      )
        continue;
      if (vs.some(close)) continue;
      if (!out.includes(part)) out.push(part);
    }
  }
  // An amount in words that is allowed vouches for its own words.
  const amounts = amountsInWords(text).filter((a) => close(a.value));
  for (const w of numberWords(text)) {
    if (amounts.some((a) => w.end > a.start && w.end <= a.end)) continue;
    const measures = MEASURES.test(text.slice(w.end));
    if ((w.value <= 20 && !measures && ctx.figure !== true) || close(w.value))
      continue;
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

/**
 * What a table row works out from its own cells: each pair's difference, sum
 * and change in percent. A number that equals one is checked by code, as if
 * written with data-calc: a 30-row sales table typed its changes, and two
 * thirds of the column was dropped as unsupported (hard asks).
 */
export const rowDerivations = (rows: readonly string[][]): number[] => {
  // A table's own row numbers are counters: a 30-row table's "#" column lost
  // rows 21 to 30 as numbers nobody gave. Only a first cell that is just that
  // number: every count up to the rows' total let a 16-row deck print a "7%"
  // nobody gave.
  const out = new Set<number>();
  for (const cells of rows) {
    const counter = /^(\d{1,3})\.?$/.exec((cells[0] ?? "").trim());
    if (counter != null && Number(counter[1]) <= rows.length)
      out.add(Number(counter[1]));
  }
  for (const cells of rows) {
    const nums = cells
      .map((cell) => tokens(cell).flatMap(values)[0])
      .filter((v): v is number => v != null && Number.isFinite(v));
    for (const a of nums)
      for (const b of nums) {
        if (a === b) continue;
        out.add(Math.abs(b - a));
        out.add(a + b);
        if (a !== 0) out.add(Math.abs(((b - a) / a) * 100));
      }
  }
  return [...out];
};
