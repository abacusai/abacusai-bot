/**
 * The routines' five-field cron parser (spec 05 §8.3, §31.5 e, §31.7): one
 * implementation, used by main's scheduler (`cron-store.ts` re-exports it)
 * and by the new renderer's schedule editor. Local time. Seconds, names and
 * `L`/`W`/`#` are rejected explicitly rather than silently misread.
 */

/**
 * A schedule that does not parse. Its message is the one the user sees; the
 * RPC layer maps it to `BAD_REQUEST { field: "schedule", detail }` without
 * reading prose. Legacy IPC sees exactly what it saw before: the plain
 * `Error` name and the same message.
 */
export class CronParseError extends Error {
  get detail(): string {
    return this.message;
  }
}

interface Field {
  min: number;
  max: number;
  values: Set<number>;
}

const parseField = (
  raw: string,
  min: number,
  max: number,
  label: string
): Field => {
  const values = new Set<number>();

  for (const part of raw.split(",")) {
    // `split` always yields a first element.
    const [range = "", stepRaw] = part.split("/");
    const step = stepRaw != null ? Number(stepRaw) : 1;

    if (!Number.isInteger(step) || step < 1)
      throw new CronParseError(`Bad step "${stepRaw}" in the ${label} field.`);

    let from: number;
    let to: number;

    if (range === "*") {
      from = min;
      to = max;
    } else if (range.includes("-")) {
      const [a = NaN, b = NaN] = range.split("-").map(Number);

      if (!Number.isInteger(a) || !Number.isInteger(b))
        throw new CronParseError(`Bad range "${range}" in the ${label} field.`);

      from = a;
      to = b;
    } else {
      const single = Number(range);

      if (!Number.isInteger(single))
        throw new CronParseError(`Bad value "${range}" in the ${label} field.`);

      from = single;
      to = single;
    }

    if (from < min || to > max || from > to) {
      throw new CronParseError(
        `The ${label} field must be between ${min} and ${max}; got "${part}".`
      );
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  return { min, max, values };
};

export interface ParsedCron {
  minute: Field;
  hour: Field;
  dayOfMonth: Field;
  month: Field;
  dayOfWeek: Field;
  /** True when both day fields are restricted, which cron treats as OR, not AND. */
  bothDaysRestricted: boolean;
}

export const parseCron = (expression: string): ParsedCron => {
  const fields = expression.trim().split(/\s+/);

  if (fields.length === 6) {
    throw new CronParseError(
      "Six-field expressions (with seconds) are not supported. Use five fields: minute hour day month weekday."
    );
  }

  if (fields.length !== 5) {
    throw new CronParseError(
      `Expected five fields (minute hour day month weekday), got ${fields.length}.`
    );
  }

  if (/[a-zA-Z]/.test(expression)) {
    throw new CronParseError(
      "Names like MON or JAN are not supported. Use numbers: 0-6 for weekday, 1-12 for month."
    );
  }

  const [minute, hour, dayOfMonth, month, weekday] = fields as [
    string,
    string,
    string,
    string,
    string,
  ];

  // 7 is Sunday, folded onto 0 after expansion: a textual rewrite would
  // corrupt "*/7" and "0-7".
  const dayOfWeek = parseField(weekday, 0, 7, "weekday");

  if (dayOfWeek.values.has(7)) {
    dayOfWeek.values.delete(7);
    dayOfWeek.values.add(0);
  }
  dayOfWeek.max = 6;

  return {
    minute: parseField(minute, 0, 59, "minute"),
    hour: parseField(hour, 0, 23, "hour"),
    dayOfMonth: parseField(dayOfMonth, 1, 31, "day-of-month"),
    month: parseField(month, 1, 12, "month"),
    dayOfWeek,
    bothDaysRestricted: dayOfMonth !== "*" && weekday !== "*",
  };
};

export const matches = (cron: ParsedCron, at: Date): boolean => {
  if (!cron.minute.values.has(at.getMinutes())) return false;
  if (!cron.hour.values.has(at.getHours())) return false;
  if (!cron.month.values.has(at.getMonth() + 1)) return false;

  const dayMatch = cron.dayOfMonth.values.has(at.getDate());
  const weekdayMatch = cron.dayOfWeek.values.has(at.getDay());

  // Standard cron quirk: both day fields restricted means EITHER matches.
  return cron.bothDaysRestricted
    ? dayMatch || weekdayMatch
    : dayMatch && weekdayMatch;
};

/**
 * Next fire strictly after `from`, or null within a year. Minute-by-minute:
 * 525,600 set lookups is milliseconds, and clearer than solving the fields.
 */
export const nextRun = (
  expression: string,
  from: Date = new Date()
): Date | null => {
  const cron = parseCron(expression);
  const at = new Date(from.getTime());

  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);

  for (let i = 0; i < 366 * 24 * 60; i++) {
    if (matches(cron, at)) return at;

    at.setMinutes(at.getMinutes() + 1);
  }

  // Reachable for impossible dates like "30 2 30 2 *" (February 30th).
  return null;
};
