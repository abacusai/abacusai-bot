/**
 * The schedule picker's model: presets over a five-field cron. Anything the
 * presets cannot express round-trips as Custom.
 */

export type SchedulePreset =
  | "manual"
  | "once"
  | "hourly"
  | "daily"
  | "weekdays"
  | "weekly"
  | "custom";

export const SCHEDULE_PRESETS: readonly SchedulePreset[] = [
  "manual",
  "once",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
  "custom",
];

/** 0 = Sunday … 6 = Saturday, as cron counts them. */
export type Weekday = 0 | 1 | 2 | 3 | 4 | 5 | 6;

export const WEEKDAYS: readonly Weekday[] = [0, 1, 2, 3, 4, 5, 6];

export interface ScheduleDraft {
  preset: SchedulePreset;
  /** `HH:MM`, the value an `<input type="time">` carries. */
  time: string;
  weekday: Weekday;
  /** The raw expression, only meaningful when the preset is `custom`. */
  custom: string;
  /** `YYYY-MM-DDTHH:MM` local, as a datetime-local input carries; `once` only. */
  runAt: string;
}

export const DEFAULT_SCHEDULE: ScheduleDraft = {
  preset: "daily",
  time: "09:00",
  weekday: 1,
  custom: "",
  runAt: "",
};

export const toLocalDateTime = (at: number): string => {
  const date = new Date(at);
  const pad = (n: number): string => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

export const fromLocalDateTime = (value: string): number | null => {
  if (value.trim().length === 0) return null;
  const at = new Date(value).getTime();
  return Number.isFinite(at) ? at : null;
};

/** Where and when a draft fires: a cron, a single instant, or nothing. */
export const composeSchedule = (
  draft: ScheduleDraft
): { schedule: string | null; runAt: number | null } =>
  draft.preset === "once"
    ? { schedule: null, runAt: fromLocalDateTime(draft.runAt) }
    : { schedule: composeCron(draft), runAt: null };

export const decomposeSchedule = (
  schedule: string | null,
  runAt: number | null
): ScheduleDraft =>
  runAt != null
    ? { ...DEFAULT_SCHEDULE, preset: "once", runAt: toLocalDateTime(runAt) }
    : decomposeCron(schedule);

export const presetHasTime = (preset: SchedulePreset): boolean =>
  preset === "daily" || preset === "weekdays" || preset === "weekly";

const splitTime = (time: string): { hour: number; minute: number } => {
  const [hourRaw, minuteRaw] = time.split(":");
  const hour = hourRaw ? Number(hourRaw) : NaN;
  const minute = minuteRaw ? Number(minuteRaw) : NaN;
  return {
    hour: Number.isInteger(hour) && hour >= 0 && hour < 24 ? hour : 9,
    minute: Number.isInteger(minute) && minute >= 0 && minute < 60 ? minute : 0,
  };
};

/** The cron the draft means, or null for a routine that only runs by hand. */
export const composeCron = (draft: ScheduleDraft): string | null => {
  const { hour, minute } = splitTime(draft.time);
  switch (draft.preset) {
    case "manual":
    case "once":
      return null;
    case "hourly":
      return `${minute} * * * *`;
    case "daily":
      return `${minute} ${hour} * * *`;
    case "weekdays":
      return `${minute} ${hour} * * 1-5`;
    case "weekly":
      return `${minute} ${hour} * * ${draft.weekday}`;
    case "custom": {
      const custom = draft.custom.trim();
      return custom.length > 0 ? custom : null;
    }
  }
};

const asTime = (minute: string, hour: string): string =>
  `${hour.padStart(2, "0")}:${minute.padStart(2, "0")}`;

export const decomposeCron = (schedule: string | null): ScheduleDraft => {
  const trimmed = schedule?.trim() ?? "";
  if (trimmed.length === 0) return { ...DEFAULT_SCHEDULE, preset: "manual" };

  const match = (pattern: RegExp): RegExpExecArray | null =>
    pattern.exec(trimmed);

  let found = match(/^(\d{1,2}) \* \* \* \*$/);
  if (found != null)
    return {
      ...DEFAULT_SCHEDULE,
      preset: "hourly",
      time: asTime(found[1], "9"),
    };
  found = match(/^(\d{1,2}) (\d{1,2}) \* \* \*$/);
  if (found != null)
    return {
      ...DEFAULT_SCHEDULE,
      preset: "daily",
      time: asTime(found[1], found[2]),
    };
  found = match(/^(\d{1,2}) (\d{1,2}) \* \* 1-5$/);
  if (found != null)
    return {
      ...DEFAULT_SCHEDULE,
      preset: "weekdays",
      time: asTime(found[1], found[2]),
    };
  found = match(/^(\d{1,2}) (\d{1,2}) \* \* ([0-6])$/);
  if (found != null)
    return {
      ...DEFAULT_SCHEDULE,
      preset: "weekly",
      time: asTime(found[1], found[2]),
      weekday: Number(found[3]) as Weekday,
    };
  return { ...DEFAULT_SCHEDULE, preset: "custom", custom: trimmed };
};

export const weekdayName = (weekday: Weekday, language: string): string => {
  // 2024-09-01 was a Sunday; day N of that week is weekday N.
  const date = new Date(2024, 8, 1 + weekday);
  return new Intl.DateTimeFormat(language, { weekday: "long" }).format(date);
};

/** "9:00 AM" / "09:00" in the UI language. */
export const formatTime = (time: string, language: string): string => {
  const { hour, minute } = splitTime(time);
  const date = new Date(2024, 8, 1, hour, minute);
  return new Intl.DateTimeFormat(language, {
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
};
