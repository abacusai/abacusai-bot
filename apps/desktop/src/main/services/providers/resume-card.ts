/**
 * "Pick up where you left off" (contract resume-card.ts), stamped from the
 * same moments "your work is waiting" (work-waiting.ts) reads: a turn in the
 * user's own chat that handed a result over, and the user's own words.
 */
import type { PrefsPatch, PrefsRow } from "@abacus-ai/contract/contract/rows";

import type { TurnEnding } from "./success-pitch";

/** The card waits hours, so a write this soon after the last one changes nothing. */
const RESUME_CARD_WROTE_STEP_MS = 10 * 60 * 1000;

/** A turn ended: one that made a site or a file is the chat the card offers next. */
export const resumeCardAfterTurn = (
  sessionId: string,
  ending: TurnEnding,
  now: number
): PrefsPatch | null =>
  ending === "site" || ending === "file"
    ? {
        dismissals: {
          resumeCard: {
            sessionId,
            resultAt: now,
            wroteAt: now,
            closedAt: null,
          },
        },
      }
    : null;

/** The user wrote: they are here, and the wait starts again. */
export const resumeCardAfterWrite = (
  row: PrefsRow,
  now: number
): PrefsPatch | null => {
  const mark = row.dismissals.resumeCard;
  return mark == null ||
    mark.closedAt != null ||
    now - mark.wroteAt < RESUME_CARD_WROTE_STEP_MS
    ? null
    : { dismissals: { resumeCard: { ...mark, wroteAt: now } } };
};
