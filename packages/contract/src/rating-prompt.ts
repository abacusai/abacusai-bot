/**
 * The rating line: one line under a finished reply asking how the bot is
 * doing in this chat, four answers and an optional comment. It is the
 * quietest thing under a reply: it never shares a reply with another card,
 * never follows one, comes about once a week at most, and backs off when it
 * is closed. The rating, the comment and what kind of task it was are sent;
 * never the chat's text.
 */

/** Worst first, as the line shows them. */
export const CHAT_RATINGS = ["bad", "okay", "good", "great"] as const;
export type ChatRating = (typeof CHAT_RATINGS)[number];

/** What the chat was mainly doing, read off its tool calls. */
export const RATING_TASK_TYPES = [
  "chat",
  "site",
  "files",
  "email",
  "research",
  "media",
  "routine",
  "connector",
] as const;
export type RatingTaskType = (typeof RATING_TASK_TYPES)[number];

/** The longest comment sent; the box stops there. */
export const RATING_COMMENT_MAX = 500;

/** The renderer's record (prefs `dismissals.ratingPrompt`). */
export interface RatingPromptCard {
  /** The reply last asked under (its message id), its thread and when. */
  shownOffer: string | null;
  shownThread: string | null;
  shownAt: number | null;
  /** The reply last answered (rated or closed). */
  answered: string | null;
  /** Closes since the last rating, and when the last one was. */
  dismissStreak: number;
  dismissedAt: number | null;
  /** Threads that could have been asked since the last ask (most recent last). */
  qualified: string[];
  /** Threads already asked in, so a chat is asked once (most recent last). */
  askedThreads: string[];
  /** Settings: never ask. */
  off: boolean;
}

export const EMPTY_RATING_PROMPT_CARD: RatingPromptCard = {
  shownOffer: null,
  shownThread: null,
  shownAt: null,
  answered: null,
  dismissStreak: 0,
  dismissedAt: null,
  qualified: [],
  askedThreads: [],
  off: false,
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** At most one ask a week. */
export const RATING_PROMPT_GAP_MS = 7 * DAY_MS;
/** After a close, two weeks. */
export const RATING_PROMPT_DISMISS_GAP_MS = 14 * DAY_MS;
/** Three closes in a row without a rating, two months. */
export const RATING_PROMPT_MAX_STREAK = 3;
export const RATING_PROMPT_STREAK_GAP_MS = 60 * DAY_MS;
/**
 * Other chats that must have qualified first: one before the very first ask
 * (never in the first chat), then three between asks (one chat in four).
 */
export const RATING_PROMPT_FIRST_AFTER = 1;
export const RATING_PROMPT_EVERY = 3;
/** How many thread ids each list keeps. */
const KEPT_THREADS = 20;

/** `list` with `threadId` last, once, cut to the newest few. */
export const keepThread = (
  list: readonly string[],
  threadId: string
): string[] =>
  [...list.filter((each) => each !== threadId), threadId].slice(-KEPT_THREADS);

/**
 * Whether the line may be asked in `threadId` now: not turned off, not
 * already asked in this chat, past the week and the close back-offs, and
 * enough other chats since the last ask.
 */
export const ratingPromptAllowed = (
  card: RatingPromptCard | null | undefined,
  threadId: string,
  now: number
): boolean => {
  const state = card ?? EMPTY_RATING_PROMPT_CARD;
  if (state.off || state.askedThreads.includes(threadId)) return false;
  if (state.shownAt != null && now - state.shownAt < RATING_PROMPT_GAP_MS)
    return false;
  if (state.dismissedAt != null) {
    const wait =
      state.dismissStreak >= RATING_PROMPT_MAX_STREAK
        ? RATING_PROMPT_STREAK_GAP_MS
        : RATING_PROMPT_DISMISS_GAP_MS;
    if (now - state.dismissedAt < wait) return false;
  }
  const others = state.qualified.filter((each) => each !== threadId).length;
  return (
    others >=
    (state.shownAt == null ? RATING_PROMPT_FIRST_AFTER : RATING_PROMPT_EVERY)
  );
};

/** At least this many of the user's own messages make a chat worth rating. */
export const RATING_PROMPT_MIN_TURNS = 3;

const TASK_PATTERNS: readonly [RatingTaskType, RegExp][] = [
  ["site", /(^|_)serve$|deploy|preview/i],
  ["routine", /routine|schedule|cron/i],
  ["media", /image|video|flux|speech|audio/i],
  ["email", /gmail|outlook|e-?mail|inbox|mail_/i],
  ["connector", /connect|oauth|mcp_install/i],
  ["research", /search|fetch|browse|research|web_/i],
  ["files", /write|edit|patch|bash|file|docx|pptx|xlsx|pdf/i],
];

/**
 * The chat's kind from its tool calls, the latest turn's first: the first
 * pattern any of them matches, else a plain chat.
 */
export const ratingTaskType = (
  latestTurnTools: readonly string[],
  threadTools: readonly string[]
): RatingTaskType => {
  for (const tools of [latestTurnTools, threadTools])
    for (const [kind, pattern] of TASK_PATTERNS)
      if (tools.some((name) => pattern.test(name))) return kind;
  return "chat";
};

/** Starts only where a word starts, and every run is bounded: linear on any text. */
const EMAIL = /(?<![\w.+-])[\w.+-]{1,64}@[\w-]{1,63}(?:\.[\w-]{1,63}){1,8}/g;
/**
 * 7 to 15 digits with up to two phone separators between them (spaces,
 * dashes, dots, brackets); an ISO date or a dotted version is not one.
 */
const PHONE =
  /(?<![\w.])(?!\d{4}-\d{2}-\d{2}\b)(?!\d{1,3}(?:\.\d{1,3}){2,6}(?![\d.]))\+?\(?\d(?:[\s().-]{0,2}\d){6,14}(?!\w|\.\d)/g;

/** The comment as it may leave the machine: no email address or phone number. */
export const redactContactDetails = (text: string): string =>
  text.replace(EMAIL, "[email]").replace(PHONE, "[phone]");
