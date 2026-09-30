/**
 * Check-ins (spec 03 §10; the spec's `shared/bots/check-in.ts`). A check-in
 * is a routine made for a bot whose prompt is exactly `CHECK_IN_PROMPT`;
 * there is no check-in concept in main (F3). The model-facing strings are
 * English and byte-identical to the old renderer's (`new-bot-dialog.tsx`),
 * pinned by the fixtures in `__fixtures__/legacy-model-strings` (§9.5).
 */
import * as v from "valibot";

import type { RoutineRow } from "#shared/contract/rows";

import {
  composeCron,
  decomposeCron,
  DEFAULT_SCHEDULE,
  weekdayName,
  type Weekday,
} from "./schedule";

/** The standing instruction a bot with no instructions starts with. */
export const NAME_ONLY_MISSION = [
  "Your mission is not set yet. Take your best cue from your name. In your",
  "first message, say what you guess your lane is, offer two or three concrete",
  "jobs you could take on, and ask the user what they actually want you",
  "handling. Once they tell you, treat that as your standing mission from then",
  "on.",
].join(" ");

/**
 * What a check-in routine asks the bot to do when it fires. Stored routines
 * are recognised by this exact text (isCheckInRoutine), so do not reword it.
 */
export const CHECK_IN_PROMPT = [
  "This is your scheduled check-in. Look at what has changed since you last",
  "spoke to the user — anything your mission tracks, anything they asked you",
  "to keep an eye on — and message them with what is worth knowing. If there",
  "is nothing new, say so in one line rather than inventing an update.",
].join(" ");

export type CheckInPreset = "off" | "hourly" | "daily" | "weekdays" | "weekly";

/** The segmented control's order (P34). */
export const CHECK_IN_PRESETS: readonly CheckInPreset[] = [
  "off",
  "hourly",
  "daily",
  "weekdays",
  "weekly",
];

export interface CheckInDraft {
  /** `custom`: a stored cron no preset expresses; shown, never rewritten. */
  preset: CheckInPreset | "custom";
  /** `HH:MM`; for hourly only the minute counts. */
  time: string;
  weekday: Weekday;
  /** The stored cron when `preset` is `custom`, else null. */
  custom: string | null;
  enabled: boolean;
}

export const DEFAULT_CHECK_IN: CheckInDraft = {
  preset: "off",
  time: DEFAULT_SCHEDULE.time,
  weekday: DEFAULT_SCHEDULE.weekday,
  custom: null,
  enabled: true,
};

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

export const CheckInDraftSchema = v.object({
  preset: v.picklist([...CHECK_IN_PRESETS, "custom"]),
  time: v.pipe(v.string(), v.regex(TIME, "time")),
  weekday: v.picklist([0, 1, 2, 3, 4, 5, 6] as const),
  custom: v.nullable(v.string()),
  enabled: v.boolean(),
});

/** `HH:MM` with the minute replaced (hourly's "At minute" field). */
export const withMinute = (time: string, minute: number): string => {
  const hour = time.split(":")[0] ?? "09";
  const clamped = Math.min(59, Math.max(0, Math.trunc(minute) || 0));
  return `${hour.padStart(2, "0")}:${String(clamped).padStart(2, "0")}`;
};

/** The check-in routine this bot's form made, among any routines. */
export const isCheckInRoutine = (
  routine: { botId: string | null; prompt: string },
  botId: string
): boolean => routine.botId === botId && routine.prompt === CHECK_IN_PROMPT;

/**
 * "The" check-in: the oldest exact-prompt routine of the bot (a duplicate
 * made in Routines is an ordinary routine; `new-bot-dialog.tsx:147-156`).
 */
export const findCheckIn = <
  R extends { botId: string | null; prompt: string; createdAt: number },
>(
  routines: Iterable<R>,
  botId: string
): R | null => {
  let found: R | null = null;
  for (const routine of routines)
    if (
      isCheckInRoutine(routine, botId) &&
      (found == null || routine.createdAt < found.createdAt)
    )
      found = routine;
  return found;
};

/**
 * The schedule in words, for the bot's own ears (English, like its prompt).
 * Byte-identical to the old dialog's output for every preset.
 */
export const describeCheckIn = (draft: {
  preset: CheckInPreset;
  time: string;
  weekday: Weekday;
}): string => {
  const { time, weekday } = draft;
  switch (draft.preset) {
    case "off":
      return "off";
    case "hourly":
      return "every hour";
    case "daily":
      return `every day at ${time}`;
    case "weekdays":
      return `weekdays at ${time}`;
    case "weekly":
      return `weekly on ${weekdayName(weekday, "en-US")} at ${time}`;
  }
};

/** The draft a stored routine means (null or no schedule: off). */
export const checkInFromRoutine = (
  routine: Pick<RoutineRow, "schedule" | "enabled"> | null
): CheckInDraft => {
  if (routine == null || routine.schedule == null) return DEFAULT_CHECK_IN;
  const decomposed = decomposeCron(routine.schedule);
  const base = {
    time: decomposed.time,
    weekday: decomposed.weekday,
    enabled: routine.enabled,
  };
  switch (decomposed.preset) {
    case "hourly":
    case "daily":
    case "weekdays":
    case "weekly":
      return { ...base, preset: decomposed.preset, custom: null };
    default:
      return {
        ...base,
        time: DEFAULT_SCHEDULE.time,
        preset: "custom",
        custom: routine.schedule.trim(),
      };
  }
};

/** The cron the draft means; `off` is null; `custom` keeps the stored cron. */
export const scheduleFromCheckIn = (draft: CheckInDraft): string | null => {
  switch (draft.preset) {
    case "off":
      return null;
    case "custom":
      return draft.custom;
    default:
      return composeCron({
        ...DEFAULT_SCHEDULE,
        preset: draft.preset,
        time: draft.time,
        weekday: draft.weekday,
      });
  }
};

export type CheckInAction =
  | { kind: "none" }
  | { kind: "insert"; schedule: string; enabled: boolean }
  | { kind: "delete"; id: string }
  | { kind: "update"; id: string; schedule?: string; enabled?: boolean };

/**
 * What saving does to the check-in routine (§10.3, parity P40/P41). Nothing
 * unless the user touched the check-in; a custom schedule is never
 * rewritten; `enabled` is written only when it differs, so a schedule edit
 * on a paused check-in keeps it paused.
 */
export const checkInPersistence = (
  before: Pick<RoutineRow, "id" | "schedule" | "enabled"> | null,
  draft: CheckInDraft,
  touched: boolean
): CheckInAction => {
  if (!touched) return { kind: "none" };
  if (before == null) {
    if (draft.preset === "off" || draft.preset === "custom")
      return { kind: "none" };
    const schedule = scheduleFromCheckIn(draft);
    return schedule == null
      ? { kind: "none" }
      : { kind: "insert", schedule, enabled: draft.enabled };
  }
  if (draft.preset === "off") return { kind: "delete", id: before.id };
  const schedule =
    draft.preset === "custom" ? before.schedule : scheduleFromCheckIn(draft);
  const scheduleChanged =
    schedule != null && schedule !== (before.schedule ?? null);
  const enabledChanged = draft.enabled !== before.enabled;
  if (!scheduleChanged && !enabledChanged) return { kind: "none" };
  return {
    kind: "update",
    id: before.id,
    ...(scheduleChanged ? { schedule } : {}),
    ...(enabledChanged ? { enabled: draft.enabled } : {}),
  };
};
