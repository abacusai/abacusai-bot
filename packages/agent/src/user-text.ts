import type { UserTextTags } from "./protocol.js";

const REMINDER_OPEN = "<system_reminder>";
const REMINDER_CLOSE = "</system_reminder>";
const ROUTINE_FIRE = /^\[routine\] "/;

/**
 * Removes each `<system_reminder>...</system_reminder>` block (shortest match,
 * left to right). A plain scan rather than a lazy regex, which goes quadratic
 * on many unclosed openers.
 */
export const stripSystemReminders = (text: string): string => {
  let out = "";
  let pos = 0;
  while (pos < text.length) {
    const open = text.indexOf(REMINDER_OPEN, pos);
    if (open < 0) break;
    const close = text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length);
    if (close < 0) break;
    out += text.slice(pos, open);
    pos = close + REMINDER_CLOSE.length;
  }
  return out + text.slice(pos);
};

export const hasSystemReminder = (text: string): boolean => {
  const open = text.indexOf(REMINDER_OPEN);
  return (
    open >= 0 && text.indexOf(REMINDER_CLOSE, open + REMINDER_OPEN.length) >= 0
  );
};

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
  if (
    tags?.visibleFrom != null &&
    (!Number.isInteger(tags.visibleFrom) ||
      tags.visibleFrom < 0 ||
      tags.visibleFrom >= text.length)
  )
    return true;
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
  const boundary = tags?.visibleFrom ?? operator?.visibleFrom;
  const human =
    boundary != null && Number.isInteger(boundary) && boundary >= 0
      ? text.slice(boundary)
      : text;
  const withoutReminders = stripSystemReminders(human).trim();
  if (ROUTINE_FIRE.test(withoutReminders)) return "";
  return withoutReminders;
};

/** A routine firing: the message is hidden entirely in the old UI. */
export const isRoutineFire = (text: string): boolean =>
  ROUTINE_FIRE.test(stripSystemReminders(text).trim());

/**
 * Tags of the notes the app writes into a user turn, in English, ahead of or
 * instead of the user's words. A turn that opens with a `whole` tag is all
 * the app's; a `part` tag owns only its own paragraph. Every tagged note a
 * prompt carries must be declared here (user-text.test.ts checks the framers).
 */
export const APP_NOTE_TAGS = {
  whole: [
    "first run",
    "routine",
    "mission updated",
    "routines moved",
    "connected",
    "upgraded",
    "reaction",
    "bot answer",
    "bot request",
    "memory flush",
    "memory maintenance",
  ],
  part: [
    "auto-reply",
    "linked",
    "note",
    "check-ins",
    "check-ins language",
    "check-ins sent",
    "first brief",
    "upgrade hint",
    "stop keyword",
    "not attached",
    "not sent",
    "delivery unconfirmed",
    "routine report",
    "routine report sent",
    "late",
  ],
} as const;

/** A tag the app may open a note in a user turn with. */
export type AppNoteTag =
  | (typeof APP_NOTE_TAGS.whole)[number]
  | (typeof APP_NOTE_TAGS.part)[number];

/** "[first run]": every app note opens with this, so its tag is one `ownWords` knows. */
export const appNoteTag = (tag: AppNoteTag): string => `[${tag}]`;

/** A note another bot sent ("[from bot Name] ..."), or a task it passed on. */
const BOT_NOTE = /^\[(?:from bot |task from the user, passed on by )/;
/**
 * Where the words start after a "[WhatsApp message from Sam] " label, as
 * `frameChannelMessage` writes it; -1 without one. A scan, not a regex, so a
 * long bracket cannot make it slow.
 */
const channelLabelEnd = (part: string): number => {
  if (!part.startsWith("[")) return -1;
  const close = part.indexOf("]");
  const newline = part.indexOf("\n");
  if (close < 0 || (newline >= 0 && newline < close)) return -1;
  if (!part.slice(1, close).includes(" message from ")) return -1;
  let end = close + 1;
  while (end < part.length && /\s/.test(part[end]!)) end += 1;
  return end;
};
/** The phone lane's line for a message read mid-task (mid-task-inbox.ts). */
const MID_TASK = /^\[user mid-task\]\s*/;
/** A saved or unread attachment, one line each (gateway and phone lane). */
const ATTACHMENT_LINE = /^\s*\[attachment(?: not read)?:[^\]\n]*\]\s*$/;
/** What the server writes for media it relayed: a voice note's words keep their prefix. */
const MEDIA_LINE = /^\s*\(sent an? (?:photo|file|voice note|video)\)\s*$/;
const VOICE_PREFIX = /^\s*\(voice note\)\s*/;

/** The routine editor's wrapper (routine-prompt.ts): the user's words come last. */
export const ROUTINE_EDITOR_OPENING = "You are the editor for the routine ";
export const ROUTINE_EDITOR_WORDS = "The user says: ";

// Tags are letters, spaces and hyphens: nothing to escape.
const tagPattern = (tags: readonly string[]): RegExp =>
  new RegExp(`^\\s*\\[(?:${tags.join("|")})\\]`);
const WHOLE_NOTE = tagPattern(APP_NOTE_TAGS.whole);
const PART_NOTE = tagPattern(APP_NOTE_TAGS.part);

/** A chat app's message as the agent reads it: who wrote, then their words. */
export const frameChannelMessage = (label: string, text: string): string =>
  `[${label}] ${text}`;

/** One paragraph's own words: labels, attachment and media lines dropped. */
const ownPart = (part: string): string =>
  part
    .slice(Math.max(channelLabelEnd(part), 0))
    .replace(MID_TASK, "")
    .split("\n")
    .filter((line) => !ATTACHMENT_LINE.test(line) && !MEDIA_LINE.test(line))
    .map((line) => line.replace(VOICE_PREFIX, ""))
    .join("\n")
    .trim();

/**
 * The user's own words in a turn, and nothing the app wrapped around them:
 * no channel label, system reminder, attachment line or app note. "" when
 * the turn was entirely the app's (a first run, a routine, another bot's
 * note). The one definition every reader of the user's language uses; the
 * tags decide where they exist, the declared envelopes otherwise (a resumed
 * transcript carries none).
 */
export const ownWords = (text: string, tags?: UserTextTags): string => {
  let words = visibleUserText(text, tags);
  if (words.length === 0 || BOT_NOTE.test(words) || WHOLE_NOTE.test(words))
    return "";
  if (words.startsWith(ROUTINE_EDITOR_OPENING)) {
    const at = words.lastIndexOf(`\n${ROUTINE_EDITOR_WORDS}`);
    words = at < 0 ? "" : words.slice(at + ROUTINE_EDITOR_WORDS.length + 1);
  }
  const parts = words.split(/\n\s*\n/);
  // A bot's routine opens with its voice, then the fire.
  if (parts.some((part) => ROUTINE_FIRE.test(part.trim()))) return "";
  // A sender chat's rules ride ahead of the first message: the label starts the words.
  const labelled = parts.findIndex((part) => channelLabelEnd(part) >= 0);
  return parts
    .slice(Math.max(labelled, 0))
    .filter((part) => !PART_NOTE.test(part))
    .map(ownPart)
    .filter((part) => part.length > 0)
    .join("\n\n");
};
