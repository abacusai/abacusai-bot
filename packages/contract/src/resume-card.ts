/**
 * "Pick up where you left off": the user's latest chat that ended on a
 * result, offered on the home screen when they come back after a long time
 * away. Main stamps the mark (prefs `dismissals.resumeCard`): the result, and
 * the user's last own message anywhere, the moments "your work is waiting"
 * starts an absence at. The renderer closes it.
 */

/** Away at least this long, and the home screen offers the chat again. */
export const RESUME_CARD_AWAY_MS = 20 * 60 * 60 * 1000;

/** The card's chips: the next steps the result ended on. */
export const RESUME_CARD_MAX_CHIPS = 3;

export interface ResumeCardMark {
  sessionId: string;
  resultAt: number;
  /** The user's last own message, in any chat. */
  wroteAt: number;
  closedAt: number | null;
}

/**
 * Whether the card shows at `now`: a result on record, not closed, and the
 * user away long enough. Any message since restarts the wait, so the card is
 * gone once they write.
 */
export const resumeCardDue = (
  mark: ResumeCardMark | null | undefined,
  now: number
): mark is ResumeCardMark =>
  mark != null &&
  mark.closedAt == null &&
  now - Math.max(mark.wroteAt, mark.resultAt) >= RESUME_CARD_AWAY_MS;
