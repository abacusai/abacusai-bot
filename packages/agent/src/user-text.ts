import type { UserTextTags } from "./protocol.js";

const SYSTEM_REMINDER = /<system_reminder>[\s\S]*?<\/system_reminder>/g;
const ROUTINE_FIRE = /^\[routine\] "/;

export const hasSystemReminder = (text: string): boolean =>
  text.search(SYSTEM_REMINDER) >= 0;

/** Old transcripts lack tags. Only the known, anchored envelopes are recognised. */
export const legacyOperator = (text: string): UserTextTags["operator"] => {
  if (text.startsWith("[first run] ")) return { kind: "kickstart" };
  if (text.startsWith("[mission updated] ")) return { kind: "mission-updated" };
  if (text.startsWith("[auto-reply] ")) {
    const boundary = text.indexOf("\n\n");
    return {
      kind: "auto-reply-intro",
      ...(boundary >= 0 && { visibleFrom: boundary + 2 }),
    };
  }
  return undefined;
};

export const isHiddenUserText = (
  text: string,
  tags?: UserTextTags
): boolean => {
  const operator = tags?.operator ?? legacyOperator(text);
  return (
    tags?.routineFire === true ||
    isRoutineFire(text) ||
    (operator != null &&
      (operator.visibleFrom == null ||
        !Number.isInteger(operator.visibleFrom) ||
        operator.visibleFrom < 0 ||
        operator.visibleFrom >= text.length))
  );
};

/** The user's own words, or "" when the message was entirely the app's. */
export const visibleUserText = (text: string, tags?: UserTextTags): string => {
  if (isHiddenUserText(text, tags)) return "";
  const operator = tags?.operator ?? legacyOperator(text);
  const human =
    operator?.visibleFrom != null ? text.slice(operator.visibleFrom) : text;
  const withoutReminders = human.replaceAll(SYSTEM_REMINDER, "").trim();
  if (ROUTINE_FIRE.test(withoutReminders)) return "";
  return withoutReminders;
};

/** A routine firing: the message is hidden entirely in the old UI. */
export const isRoutineFire = (text: string): boolean =>
  ROUTINE_FIRE.test(text.replaceAll(SYSTEM_REMINDER, "").trim());
