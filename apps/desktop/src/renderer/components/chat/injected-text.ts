/**
 * Strips the app's own text out of a user message before it is shown: the
 * scheduler's routine prompt and the `<system_reminder>` environment notice
 * are written for the model, not typed by the reader. Display only; the
 * transcript keeps every byte.
 */

const SYSTEM_REMINDER = /<system_reminder>[\s\S]*?<\/system_reminder>/g;

/** The scheduler's envelope. Its whole message is machine text. */
const ROUTINE_FIRE = /^\[routine\] "/;

/** The user's own words, or "" when the message was entirely the app's. */
export const visibleUserText = (text: string): string => {
  const withoutReminders = text.replaceAll(SYSTEM_REMINDER, "").trim();
  if (ROUTINE_FIRE.test(withoutReminders)) return "";
  return withoutReminders;
};
