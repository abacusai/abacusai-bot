/**
 * Tomorrow's result (contract overnight.ts), the app's side: what a booked
 * overnight routine runs, and when its one notice shows. The routine itself
 * is an ordinary one-time local routine: the scheduler fires it, a computer
 * that was off fires it at launch, and its answer reaches the chat as a run
 * report. These are the decisions on top of that, kept pure.
 */
import { OVERNIGHT_ENVELOPE } from "@abacus-ai/contract/overnight";
import type { RoutineOvernight } from "@abacus-ai/contract/routines";

/** A run that failed is booked once more, then left. */
const OVERNIGHT_MAX_ATTEMPTS = 2;
/** A result not brought up this long after its ready hour is no longer news. */
const OVERNIGHT_NOTICE_EXPIRES_MS = 2 * 24 * 60 * 60 * 1000;
/** Done this long after the ready hour (the computer was off): said as late. */
const OVERNIGHT_LATE_AFTER_MS = 15 * 60 * 1000;
/** A task longer than this is cut, so the notice stays one line. */
const OVERNIGHT_LINE_MAX_CHARS = 120;

/**
 * The routine's prompt: the plan written while the chat was in view. It opens
 * with the envelope and the booked chat's id, which the server reads.
 */
export const overnightPrompt = (sessionId: string, plan: string): string =>
  [
    `${OVERNIGHT_ENVELOPE}${sessionId}`,
    "The user booked this work in a chat and has left; nobody is watching. Do it now, in one focused pass:",
    "",
    plan,
    "",
    "No new accounts, no payments, nothing sent to anyone, no questions mid-way: where you would ask, pick the",
    "likelier way and say so. End with a short answer in the user's language, written for them to read in the",
    "morning: what is ready (one line per change) and the one choice left to them, as a question.",
  ].join("\n");

/** What the morning check does with a booking: show its notice (as on time or late), drop it, or wait. */
export type OvernightNoticeStep = "morning" | "late" | "expired" | null;

export const overnightNoticeStep = (
  overnight: RoutineOvernight,
  now: number,
  quiet: boolean
): OvernightNoticeStep => {
  if (overnight.shownAt != null || now < overnight.readyAt) return null;
  if (now - overnight.readyAt >= OVERNIGHT_NOTICE_EXPIRES_MS) return "expired";
  // Not done yet (the computer was off): said once the run lands.
  if (overnight.doneAt == null || quiet) return null;
  return overnight.doneAt - overnight.readyAt > OVERNIGHT_LATE_AFTER_MS
    ? "late"
    : "morning";
};

/** Whether a failed run is booked again. */
export const overnightRetries = (overnight: RoutineOvernight): boolean =>
  (overnight.attempts ?? 0) < OVERNIGHT_MAX_ATTEMPTS;

/** The task as one notice line. */
export const overnightLine = (text: string): string => {
  const one = text.replace(/\s+/g, " ").trim();
  return one.length > OVERNIGHT_LINE_MAX_CHARS
    ? `${one.slice(0, OVERNIGHT_LINE_MAX_CHARS - 1).trimEnd()}…`
    : one;
};
