/**
 * The retry offer: when a task goes badly on a free account, one line under
 * the reply offering the same task again on one of the plan's top models. The
 * renderer reads the reason off the chat; a tap opens the upgrade dialog, and
 * once paid the message runs again on that model. Half the free accounts get
 * it, so what it does to upgrades can be read against the half that do not.
 */
import { isCleanReply, normalizedText, wordsPattern } from "./success-pitch";

export const RETRY_OFFER_REASONS = ["failed", "complaint", "repeat"] as const;
export type RetryOfferReason = (typeof RETRY_OFFER_REASONS)[number];

/** What the user says when the last attempt did not work. */
const STUCK_WORDS = [
  // English
  "still not",
  "still doesn't",
  "still broken",
  "still the same",
  "still failing",
  "still getting",
  "doesn't work",
  "does not work",
  "didn't work",
  "did not work",
  "not working",
  "isn't working",
  "same error",
  "same problem",
  "same issue",
  "nothing changed",
  "didn't fix",
  "not fixed",
  // Portuguese
  "não funciona",
  "não funcionou",
  "não está funcionando",
  "ainda não",
  "mesmo erro",
  "mesmo problema",
  "não mudou",
  // Spanish
  "no funciona",
  "no funcionó",
  "sigue sin",
  "sigue igual",
  "mismo error",
  "mismo problema",
  "no cambió",
  // Turkish
  "çalışmıyor",
  "çalışmadı",
  "olmadı",
  "hâlâ",
  "hala",
  "aynı hata",
  "aynı sorun",
  "düzelmedi",
  "değişmedi",
  // German
  "funktioniert nicht",
  "geht nicht",
  "immer noch",
  "gleicher fehler",
  "gleiche fehler",
  // French
  "ne marche pas",
  "ne fonctionne pas",
  "toujours pas",
  "même erreur",
  "même problème",
  // Italian
  "non funziona",
  "non ha funzionato",
  "ancora non",
  "stesso errore",
  "stesso problema",
  // Indonesian
  "tidak berfungsi",
  "tidak jalan",
  "masih error",
  "masih sama",
  "belum berhasil",
];
const STUCK = wordsPattern(STUCK_WORDS);

/** Longer than this is a new brief, whatever words it uses. */
const STUCK_MAX_LENGTH = 300;

/** The message says the last attempt did not work. */
export const isStuckMessage = (text: string): boolean => {
  const message = normalizedText(text);
  return message.length <= STUCK_MAX_LENGTH && STUCK.test(message);
};

const askWords = (text: string): Set<string> =>
  new Set(normalizedText(text).match(/[\p{L}\p{N}]+/gu) ?? []);

/** Fewer words than this is "continue" or "yes", which repeats nothing. */
const SAME_ASK_MIN_WORDS = 4;
const SAME_ASK_OVERLAP = 0.8;

/** The two messages ask for the same thing: nearly the same words. */
export const isSameAsk = (a: string, b: string): boolean => {
  const first = askWords(a);
  const second = askWords(b);
  if (first.size < SAME_ASK_MIN_WORDS || second.size < SAME_ASK_MIN_WORDS)
    return false;
  const shared = [...first].filter((word) => second.has(word)).length;
  return shared / (first.size + second.size - shared) >= SAME_ASK_OVERLAP;
};

export interface RetryOfferTurn {
  /** The user's words that opened the latest turn. */
  ask: string;
  /** Their last messages before it, the latest first. */
  earlierAsks: readonly string[];
  /** The turn's final reply. */
  reply: string;
  /** The turn ran tools that build or change something. */
  ranWork: boolean;
  /** So did the turn before it. */
  earlierRanWork: boolean;
}

/**
 * Why this turn went badly, or null. A failure counts only after work: a reply
 * that declines a request runs no tools, and a better model is no answer to it.
 */
export const retryOfferReason = (
  turn: RetryOfferTurn
): RetryOfferReason | null => {
  if (turn.ranWork && !isCleanReply(turn.reply)) return "failed";
  if (turn.earlierRanWork && isStuckMessage(turn.ask)) return "complaint";
  if (turn.earlierAsks.slice(0, 2).some((ask) => isSameAsk(ask, turn.ask)))
    return "repeat";
  return null;
};

/** FNV-1a: an account's half must not move between launches or builds. */
const hash = (text: string): number => {
  let value = 0x811c9dc5;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 0x01000193);
  }
  return value >>> 0;
};

/** Whether this account is in the half that gets the offer. */
export const retryOfferForAccount = (accountKey: string): boolean =>
  hash(`retry-offer:${accountKey}`) % 2 === 0;

const comparable = (text: string): string =>
  text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/**
 * The model to offer: of the plan's top models, Claude Opus first, then the
 * plan's order, the first the catalog lists as locked. Null when none is: the
 * plan's line and the catalog must agree, or the rerun would land on a model
 * the plan cannot run.
 */
export const retryOfferModel = <
  T extends { id: string; label: string; access?: string },
>(
  topModels: readonly string[],
  catalog: readonly T[]
): T | null => {
  const locked = catalog.filter((model) => model.access === "locked");
  const ordered = [
    ...topModels.filter((name) => /opus/i.test(name)),
    ...topModels.filter((name) => !/opus/i.test(name)),
  ];
  for (const name of ordered) {
    const wanted = comparable(name);
    const found = locked.find((model) =>
      comparable(model.label).includes(wanted)
    );
    if (found != null) return found;
  }
  return null;
};
