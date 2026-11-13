/**
 * The success pitch: right after a free account got a good result, one card
 * under it with the plan's whole pitch. Two signals: the user's next message
 * is a short positive reaction (or a thumbs-up / positive emoji on the reply),
 * or a result handed over a site or a file. Main reads both off the turn
 * that closed (TurnLedger) and stamps an offer in the prefs row; the renderer
 * shows it and keeps the answer. Once half the free grant is used, the credit
 * milestone cards own the pitch and this one stops.
 *
 * Two more cards share its slot and offer: a chat whose build got big
 * (`big_task`), and a turn that left something meant to stay on, a server or
 * bot started in the background or a routine (`keep_running`), which offers
 * a personal agent on the web that keeps it running with the computer off.
 * A paid plan gets the second as the deploy steps instead (site-deploy.ts),
 * as it does for a site.
 */

/** Why the card was offered; the funnel's detail. */
export const SUCCESS_PITCH_TRIGGERS = [
  "positive_reaction",
  "deliverable",
  "big_task",
  "keep_running",
] as const;
export type SuccessPitchTrigger = (typeof SUCCESS_PITCH_TRIGGERS)[number];

/** What the user got, for the card's first line. */
export const SUCCESS_PITCH_MOMENTS = [
  "site",
  "file",
  "reaction",
  "big_task",
  "server",
  "routine",
] as const;
export type SuccessPitchMoment = (typeof SUCCESS_PITCH_MOMENTS)[number];

/** The pitch line that leads for the moment (billing-plan PitchLine). */
export const SUCCESS_PITCH_LEADS = ["apps", "agents", "media"] as const;
export type SuccessPitchLead = (typeof SUCCESS_PITCH_LEADS)[number];

/** One card owed under a session's latest reply, as main stamped it. */
export interface SuccessPitchOffer {
  /** The turn it is for (TurnLedger turnId), plus a suffix for a reaction. */
  id: string;
  sessionId: string;
  trigger: SuccessPitchTrigger;
  moment: SuccessPitchMoment;
  lead: SuccessPitchLead | null;
  at: number;
  /** `big_task`: the chat's task; `keep_running`: the thing to keep on. */
  name?: string | null;
  /** The funnel's detail when it is not the trigger: the big build's file count. */
  detail?: string | null;
}

/** Main's record for one account (creditAccountKey). */
export interface SuccessPitchMark {
  offer: SuccessPitchOffer | null;
  /** The user's own finished turns typed in the app, and sent from their own chat apps. */
  appTurns: number;
  chatTurns: number;
  /** When the once-ever line went to the user's own chat app. */
  chatToldAt: number | null;
  /** Chats offered the big-build card, newest last: once per chat. */
  bigTaskChats?: string[];
  /** Things offered "keep it running" (keepThingKey), newest last: once per thing. */
  keepOffered?: string[];
}

/** The renderer's record for one account: what was shown and answered. */
export interface SuccessPitchCard {
  /** Cards shown, ever. */
  shown: number;
  lastShownAt: number | null;
  /** "Not now" (or the close button) answers, ever. */
  notNow: number;
  /** The offer last shown, which stays on screen until answered. */
  shownOffer: string | null;
  /** The offer last answered, never shown again. */
  answered: string | null;
}

/** At most one pitch in this long. */
export const SUCCESS_PITCH_GAP_MS = 3 * 24 * 60 * 60 * 1000;
/** At most this many, ever (the card and the chat-app line together). */
export const SUCCESS_PITCH_MAX_SHOWN = 3;
/** Two "Not now"s and it never comes back. */
export const SUCCESS_PITCH_MAX_NOT_NOW = 2;

/** How often a card may show: the gap between two, and the lifetime caps. */
export interface PitchCaps {
  gapMs: number;
  maxShown: number;
  maxNotNow: number;
}

export const SUCCESS_PITCH_CAPS: PitchCaps = {
  gapMs: SUCCESS_PITCH_GAP_MS,
  maxShown: SUCCESS_PITCH_MAX_SHOWN,
  maxNotNow: SUCCESS_PITCH_MAX_NOT_NOW,
};

/**
 * "Keep it running" offers an action, not only a pitch: its own budget, at
 * most one a day and three ever, and two "Not now"s end it.
 */
export const KEEP_RUNNING_CAPS: PitchCaps = {
  gapMs: 24 * 60 * 60 * 1000,
  maxShown: 3,
  maxNotNow: 2,
};

/** The trigger's budget: "keep it running" has its own; the rest share the pitch's. */
export const pitchCaps = (trigger: SuccessPitchTrigger): PitchCaps =>
  trigger === "keep_running" ? KEEP_RUNNING_CAPS : SUCCESS_PITCH_CAPS;

/** Chats and things remembered as offered, per account. */
export const PITCH_OFFERED_KEEP = 20;

/** `list` with `item` last, at most PITCH_OFFERED_KEEP long. */
export const rememberOffered = (
  list: readonly string[] | undefined,
  item: string
): string[] =>
  [...(list ?? []).filter((each) => each !== item), item].slice(
    -PITCH_OFFERED_KEEP
  );

// ─── a big build ─────────────────────────────────────────────────────────

/**
 * Distinct files written or edited in one chat: from here a build is big.
 * Replayed over a week of chats, about one coder chat in five gets there and
 * almost no other; a long turn or the credits a chat billed fired on most
 * coder chats from their first turn, so they are not signals.
 */
export const BIG_TASK_FILES = 15;

export const isBigBuild = (files: number): boolean => files >= BIG_TASK_FILES;

// ─── something meant to stay on ──────────────────────────────────────────

export const KEEP_KINDS = ["server", "site", "routine"] as const;
export type KeepKind = (typeof KEEP_KINDS)[number];

/** One thing to keep on, so it is offered once: its kind and its folder or name. */
export const keepThingKey = (
  kind: KeepKind,
  where: string | null | undefined
): string => `${kind}:${where ?? ""}`;

/**
 * A backgrounded command that is meant to keep running (a server, a bot's
 * loop, a poller), not one-off work set aside: installs, builds, tests.
 */
const ONE_OFF_COMMAND =
  /\b(?:install|i|add|ci|build|test|tests|lint|compile|tsc|pytest|jest|vitest|playwright|sleep|wait|download|curl|wget|tar|unzip|zip|cp|mv|rm|git|docker\s+(?:build|pull|push))\b/i;

export const isLongRunningCommand = (command: string): boolean => {
  const last =
    command
      .split(/&&|;|\|\|/)
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .at(-1) ?? "";
  return last.length > 0 && !/^cd\s/.test(last) && !ONE_OFF_COMMAND.test(last);
};

/** The folder a command runs in, from a leading `cd`; null without one. */
export const commandFolder = (command: string): string | null => {
  const match = /^\s*cd\s+("[^"]+"|'[^']+'|[^\s;&|]+)/.exec(command);
  return match == null ? null : match[1]!.replace(/^["']|["']$/g, "");
};

export const EMPTY_SUCCESS_PITCH_MARK: SuccessPitchMark = {
  offer: null,
  appTurns: 0,
  chatTurns: 0,
  chatToldAt: null,
};

/**
 * Whether one more pitch may show now: under the lifetime and "Not now"
 * caps, and none in the last three days. The chat-app line counts as a show.
 */
export const successPitchAllowed = (
  card: SuccessPitchCard | undefined,
  mark: Pick<SuccessPitchMark, "chatToldAt"> | undefined,
  now: number,
  caps: PitchCaps = SUCCESS_PITCH_CAPS
): boolean => {
  const told = mark?.chatToldAt ?? null;
  const shown = (card?.shown ?? 0) + (told != null ? 1 : 0);
  const last = Math.max(card?.lastShownAt ?? -Infinity, told ?? -Infinity);
  return (
    shown < caps.maxShown &&
    (card?.notNow ?? 0) < caps.maxNotNow &&
    !(now - last < caps.gapMs)
  );
};

/**
 * The free grant is still under half used: past it the credit milestone cards
 * (credit-thresholds.ts) own the pitch. Unknown figures are not guessed at.
 */
export const underHalfOfFreeCredits = (
  used: number | null | undefined,
  granted: number | null | undefined
): boolean =>
  used != null && granted != null && granted > 0 && used / granted < 0.5;

/** The user works mainly from their own chat apps rather than in the app. */
export const mainlyInChatApps = (
  mark: Pick<SuccessPitchMark, "appTurns" | "chatTurns"> | undefined
): boolean => (mark?.chatTurns ?? 0) > (mark?.appTurns ?? 0);

/** The card's first line, per moment (locale keys). */
export const SUCCESS_PITCH_MOMENT_COPY = {
  site: "successPitch.moment.site",
  file: "successPitch.moment.file",
  reaction: "successPitch.moment.reaction",
} as const satisfies Record<
  Exclude<SuccessPitchMoment, "big_task" | "server" | "routine">,
  string
>;

// ─── what a message says about the result ───────────────────────────────

/** A message longer than this is a new request, not a reaction. */
const REACTION_MAX_LENGTH = 220;
/** The praise has to open the message. */
const REACTION_HEAD_LENGTH = 40;

/**
 * Praise, in the languages the app speaks and the ones its users write in.
 * A trailing `*` matches a stem ("teşekkür*" is also "teşekkürler").
 */
const POSITIVE_WORDS = [
  // English
  "thanks",
  "thank you",
  "thank u",
  "thx",
  "ty",
  "tysm",
  "amazing",
  "awesome",
  "perfect",
  "great",
  "excellent",
  "love it",
  "love this",
  "wow",
  "brilliant",
  "impressive",
  "fantastic",
  "incredible",
  "nice",
  "good job",
  "well done",
  "it works",
  "works great",
  "works perfectly",
  "cool",
  // Português
  "obrigad*",
  "valeu",
  "vlw",
  "perfeito",
  "perfeita",
  "incrível",
  "incrivel",
  "ótimo",
  "otimo",
  "maravilh*",
  "funcionou",
  "sensacional",
  "show de bola",
  "muito bom",
  "deu certo",
  "top demais",
  // Türkçe
  "teşekkür*",
  "tesekkur*",
  "sağol*",
  "sagol*",
  "harika*",
  "mükemmel",
  "mukemmel",
  "süper",
  "super",
  "çok iyi",
  "çok güzel",
  "eline sağlık",
  "efsane",
  "çalıştı",
  // Español
  "gracias",
  "genial",
  "perfecto",
  "increíble",
  "funcionó",
  "buenísimo",
  "excelente",
  // Deutsch, Français, Italiano
  "danke",
  "perfekt",
  "toll",
  "merci",
  "parfait",
  "génial",
  "grazie",
  "perfetto",
  "fantastico",
  // Bahasa Indonesia
  "terima kasih",
  "makasih",
  "mantap",
];

/** Praise in scripts without spaces between words: matched anywhere in the opening. */
const POSITIVE_UNSPACED = ["ありがとう", "完璧", "감사", "고마워"];

/**
 * A problem with the result: a negation, a failure, a repeat ask. Any of
 * these vetoes praise, and after the card they withdraw it.
 */
const COMPLAINT_WORDS = [
  // English
  "not",
  "no",
  "don't",
  "doesn't",
  "didn't",
  "isn't",
  "wasn't",
  "aren't",
  "can't",
  "couldn't",
  "won't",
  "dont",
  "doesnt",
  "didnt",
  "isnt",
  "cant",
  "wont",
  "broken",
  "broke",
  "error*",
  "bug*",
  "wrong",
  "still",
  "again",
  "fail*",
  "problem*",
  "issue*",
  "nothing",
  "missing",
  "useless",
  "terrible",
  "awful",
  "worst",
  "where is",
  "would be nice",
  // Português
  "não",
  "nao",
  "erro*",
  "ainda",
  "de novo",
  "nada",
  "nenhum*",
  "quebr*",
  "péssim*",
  "pessim*",
  "horrível",
  "ruim",
  "seria bom",
  "seria legal",
  "cadê",
  // Türkçe
  "değil",
  "degil",
  "olmad*",
  "olmuyor",
  "çalışmı*",
  "calismi*",
  "açılmı*",
  "hata*",
  "hâlâ",
  "hala",
  "tekrar",
  "yanlış",
  "hiç",
  "berbat",
  "kötü",
  "olsa iyi",
  "siktir*",
  // Español
  "todavía",
  "otra vez",
  "mal",
  "falla*",
  "roto",
  // Deutsch, Français, Italiano
  "nicht",
  "kein*",
  "fehler*",
  "immer noch",
  "kaputt",
  "pas",
  "erreur*",
  "encore",
  "cassé",
  "non",
  "errore",
  "ancora",
  "rotto",
  // Bahasa Indonesia
  "tidak",
  "belum",
  "gagal",
  "salah",
];

/** A change of course after the praise ("great, but ..."): not a reaction. */
const TURN_WORDS = [
  "but",
  "mas",
  "ama",
  "fakat",
  "pero",
  "aber",
  "mais",
  "ma",
  "tapi",
];

/** Emoji that read as praise when a message is nothing else. */
const POSITIVE_EMOJI = [
  "👍",
  "🙏",
  "🔥",
  "❤️",
  "❤",
  "😍",
  "🥰",
  "👏",
  "🙌",
  "💯",
  "🎉",
  "🤩",
  "😊",
  "🤗",
  "💪",
  "⭐",
  "🌟",
  "✨",
  "💜",
  "💙",
  "💚",
  "🧡",
  "💛",
];

const escape = (word: string): string =>
  word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * One pattern for a word list, on letter boundaries in any script (`\b` only
 * knows ASCII). Alternatives of literals, so matching stays linear.
 */
export const wordsPattern = (words: readonly string[]): RegExp =>
  new RegExp(
    `(?<![\\p{L}\\p{N}])(?:${words
      .map((word) =>
        word.endsWith("*")
          ? escape(word.slice(0, -1))
          : `${escape(word)}(?![\\p{L}\\p{N}])`
      )
      .join("|")})`,
    "u"
  );

const POSITIVE = wordsPattern(POSITIVE_WORDS);
const COMPLAINT = wordsPattern(COMPLAINT_WORDS);
const TURN = wordsPattern(TURN_WORDS);
/** A question anywhere: they want something more, not to say thanks. */
const QUESTION = /[?¿؟？]/u;

export const normalizedText = (text: string): string =>
  text
    .normalize("NFC")
    .toLowerCase()
    // "İ" lowercases to "i" and a combining dot outside Turkish.
    .replace(/̇/g, "")
    .replace(/[’`]/g, "'")
    .trim();

/** Nothing but emoji, punctuation and spaces, with at least one that praises. */
const onlyPositiveEmoji = (text: string): boolean => {
  if (!POSITIVE_EMOJI.some((emoji) => text.includes(emoji))) return false;
  return !/[\p{L}\p{N}]/u.test(text);
};

/** A message that names a problem with the result. */
export const isComplaint = (text: string): boolean =>
  COMPLAINT.test(normalizedText(text));

/**
 * A short positive reaction to the result: praise (a word from the lexicon
 * opening the message, or only positive emoji), and no complaint, no "but",
 * no question anywhere in it.
 */
export const isPositiveReaction = (text: string): boolean => {
  const message = normalizedText(text);
  if (message.length === 0 || message.length > REACTION_MAX_LENGTH)
    return false;
  if (onlyPositiveEmoji(message)) return true;
  const head = message.slice(0, REACTION_HEAD_LENGTH);
  if (
    !POSITIVE.test(head) &&
    !POSITIVE_UNSPACED.some((word) => head.includes(word))
  )
    return false;
  return (
    !COMPLAINT.test(message) && !TURN.test(message) && !QUESTION.test(message)
  );
};

/** A reaction emoji on the bot's reply that counts as praise. */
export const isPositiveReactionEmoji = (emoji: string): boolean =>
  POSITIVE_EMOJI.includes(emoji);

/** A refusal or a failure shows in the reply's opening. */
const CLEAN_REPLY_HEAD_LENGTH = 400;

/** The reply says it could not do it. */
const REFUSAL_WORDS = [
  "can't",
  "cannot",
  "couldn't",
  "unable",
  "won't",
  "not able",
  "out of credits",
  "não consegui",
  "não posso",
  "não foi possível",
  "yapamad*",
  "yapamıyorum",
  "veremiyorum",
  "no puedo",
  "no pude",
  "no fue posible",
  "konnte nicht",
  "kann nicht",
  "je ne peux pas",
  "impossible",
  "non riesco",
  "non posso",
  "tidak bisa",
  // A file that came out broken, said in the reply
  "does not open",
  "doesn't open",
  "won't open",
  "no abre",
  "não abre",
  "açılmıyor",
  "öffnet nicht",
  "لم أتمكن",
  "لا أستطيع",
  "ما قدرت",
  "не удалось",
  "не могу",
  "nie udało",
  "nie mogę",
  "kunne ikke",
  "kon niet",
  "无法",
  "できません",
];
const REFUSAL = wordsPattern(REFUSAL_WORDS);

/**
 * The turn's final reply does not say it failed: no refusal in its opening.
 * Its length and an offer of more at the end ("Want me to add ...?") say
 * nothing about the result.
 */
export const isCleanReply = (reply: string): boolean =>
  !REFUSAL.test(normalizedText(reply).slice(0, CLEAN_REPLY_HEAD_LENGTH));
