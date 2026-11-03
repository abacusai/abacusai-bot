/**
 * When a routine the agent asks for fires: a schedule, or one moment from
 * `run_at` or `in_minutes`. Every ask is taken in its most sensible reading
 * and never refused; what was read differently from how it was written comes
 * back as a warning the tool result carries. One reading for a local routine
 * and a hosted one.
 */
import { frequentFiresPerDay } from "@abacus-ai/contract/routines/cron";

export interface RoutineTiming {
  /** The five-field cron, or null for a one-time or webhook routine. */
  schedule: string | null;
  /** The one-time moment, or null. */
  runAt: number | null;
  /**
   * The moment as the hosted server should read it: the user's own words
   * when they were taken as written (the server reads them in the user's
   * zone), else the exact instant.
   */
  runAtText: string | null;
  warnings: string[];
}

/** A run_at with a date and no time is read at this hour, local time. */
const DATE_ONLY_HOUR = 9;

const text = (value: unknown): string =>
  typeof value === "string" ? value.trim() : "";

const given = (value: unknown): boolean =>
  value != null && !(typeof value === "string" && value.trim() === "");

const DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** `run_at` as a moment, or null with the reason it could not be read. */
const readRunAt = (
  raw: string,
  warnings: string[]
): { at: number; asWritten: boolean } | null => {
  const day = DATE_ONLY.exec(raw);
  if (day != null) {
    const at = new Date(
      Number(day[1]),
      Number(day[2]) - 1,
      Number(day[3]),
      DATE_ONLY_HOUR
    ).getTime();
    warnings.push(
      `run_at "${raw}" has no time, so it was set for ${new Date(at).toLocaleString()}; update it with run_at and a time if they meant another.`
    );
    return { at, asWritten: false };
  }
  const at = Date.parse(raw);
  if (!Number.isFinite(at)) {
    warnings.push(
      `run_at "${raw}" is not a date and time, so it was left out; a moment reads like 2026-10-20T08:20 (this computer's local time) or with an offset.`
    );
    return null;
  }
  return { at, asWritten: true };
};

/** The ask's timing, in its most sensible reading, with what was changed. */
export const readRoutineTiming = (
  args: Record<string, unknown>,
  now: number
): RoutineTiming => {
  const warnings: string[] = [];
  let schedule: string | null = text(args.schedule) || null;
  let once: { at: number; asWritten: boolean } | null = null;

  if (given(args.run_at)) {
    once = readRunAt(text(args.run_at), warnings);
    if (given(args.in_minutes))
      warnings.push("Both run_at and in_minutes were given: run_at was used.");
  }
  if (once == null && given(args.in_minutes)) {
    const minutes = Number(args.in_minutes);
    if (Number.isFinite(minutes) && minutes > 0)
      once = { at: now + Math.round(minutes * 60_000), asWritten: false };
    else
      warnings.push(
        `in_minutes "${String(args.in_minutes)}" is not a number of minutes above 0, so it was left out.`
      );
  }
  // A minute of slack: "now" said a moment ago is still now.
  if (once != null && once.at < now - 60_000) {
    warnings.push(
      `${new Date(once.at).toLocaleString()} has already passed, so it runs once now instead.`
    );
    once = { at: now, asWritten: false };
  }
  if (once != null && schedule != null) {
    warnings.push(
      `A one-time moment and the schedule "${schedule}" were both given: it runs once at the moment, and the schedule was left out.`
    );
    schedule = null;
  }
  const fires = schedule == null ? null : frequentFiresPerDay(schedule);
  if (fires != null)
    warnings.push(
      (fires >= 24 * 60
        ? `"${schedule}" fires every minute, a full run each time, for as long as it exists. For a one-time reminder, update it with in_minutes or run_at instead.`
        : `"${schedule}" fires ${fires} times a day, a full run each time.`) +
        " Every run spends the user's credits like a chat turn, so at this rate a free plan's monthly credits can be gone within days." +
        " Unless the user asked for this rhythm in so many words, update it to a slower one (once a day, or a few set times); either way, tell them how often it runs and that each run uses credits."
    );

  return {
    schedule,
    runAt: once?.at ?? null,
    runAtText:
      once == null
        ? null
        : once.asWritten
          ? text(args.run_at)
          : new Date(once.at).toISOString(),
    warnings,
  };
};
