/**
 * Weekdays the page gets wrong, corrected from their dates. The app knows
 * every date's weekday; a model often does not: a holiday rota printed 2025's
 * calendar for 2026 (28 December a Sunday, 1 January a Thursday), with the
 * weekdays in their own table column, where a sentence check never looked.
 *
 * Self-contained page script (run in the print window, as charts and sums are):
 * corrects "Thursday 1 January" in running text, and a table row's weekday
 * cell beside a date cell. A date without a year is the next one from today.
 * Returns what it changed, for the result to say.
 */
export function correctWeekdays(doc: Document, today: string): string[] {
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
  const now = new Date(today.replace(/^[A-Za-z]+,?\s*/, ""));
  if (Number.isNaN(now.getTime())) return [];
  const monthOf = (w: string): number =>
    MONTHS.findIndex((m) => m.toLowerCase() === w.toLowerCase());
  const dayName = (
    day: number,
    month: number,
    year?: number
  ): string | null => {
    let y = year ?? now.getFullYear();
    if (year == null && new Date(y, month, day + 1) < now) y += 1;
    const d = new Date(y, month, day);
    return d.getMonth() === month ? DAYS[d.getDay()]! : null;
  };
  const DAY = DAYS.join("|");
  const MON = MONTHS.join("|");
  const dated = new RegExp(
    `\\b(${DAY})(,?\\s+)(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})|(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?`,
    "gi"
  );
  const dateOnly = new RegExp(
    `^\\s*(?:(\\d{1,2})(?:st|nd|rd|th)?\\s+(${MON})|(${MON})\\s+(\\d{1,2})(?:st|nd|rd|th)?)(?:,?\\s+(\\d{4}))?\\s*$`,
    "i"
  );
  const fixed: string[] = [];
  const styled = (right: string, like: string): string =>
    like === like.toUpperCase() ? right.toUpperCase() : right;

  // Running text: "Thursday 1 January" -> "Friday 1 January".
  const walk = doc.createTreeWalker(doc.body, 4 /* SHOW_TEXT */);
  for (let n = walk.nextNode(); n; n = walk.nextNode()) {
    const text = n.nodeValue ?? "";
    if (!dated.test(text)) continue;
    dated.lastIndex = 0;
    n.nodeValue = text.replace(
      dated,
      (all, wd: string, sep: string, d1, m1, m2, d2, yr) => {
        const month = monthOf((m1 ?? m2) as string);
        const right = dayName(
          Number(d1 ?? d2),
          month,
          yr ? Number(yr) : undefined
        );
        if (right == null || right.toLowerCase() === wd.toLowerCase())
          return all;
        fixed.push(`${all.trim()} → ${right}`);
        return styled(right, wd) + sep + all.slice(wd.length + sep.length);
      }
    );
  }
  // Tables: a weekday cell beside a date cell in the same row.
  for (const row of Array.from(doc.querySelectorAll("table tr"))) {
    const cells = Array.from((row as HTMLTableRowElement).cells);
    const dateCell = cells.find((c) => dateOnly.test(c.textContent ?? ""));
    const dayCell = cells.find((c) =>
      new RegExp(`^\\s*(${DAY})\\s*$`, "i").test(c.textContent ?? "")
    );
    if (!dateCell || !dayCell) continue;
    const m = dateOnly.exec(dateCell.textContent ?? "")!;
    const month = monthOf((m[2] ?? m[3]) as string);
    const right = dayName(
      Number(m[1] ?? m[4]),
      month,
      m[5] ? Number(m[5]) : undefined
    );
    const was = (dayCell.textContent ?? "").trim();
    if (right == null || right.toLowerCase() === was.toLowerCase()) continue;
    fixed.push(`${(dateCell.textContent ?? "").trim()}: ${was} → ${right}`);
    dayCell.textContent = styled(right, was);
  }
  return fixed;
}
