/**
 * The top-model hint: one line above the composer, for an account whose plan
 * already includes the top models while the chat runs on the plan's low-cost
 * router. It offers the plan's Sonnet and Opus in one tap each (the chat
 * moves, never the app's default) and the model picker for the rest.
 *
 * Which model leads is a credit question. On a typical coding turn (about
 * eight calls over a mostly cached context) Opus costs about twice what Sonnet
 * does, so a chat moved to Opus spends a month of credits in about half the
 * turns. The hint leads with Sonnet; Opus, the stronger and dearer one, is the
 * second button, and the retry under a stuck task offers Opus for that one
 * run (retry-offer.ts).
 */
import { planCatalogModel } from "./retry-offer";

/** The renderer's record: what was shown, answered and when. */
export interface TopModelHintCard {
  /** Hints shown, ever. */
  shown: number;
  /** The chats it was shown in, the latest last (at most TOP_MODEL_HINT_THREADS). */
  threads: string[];
  /** The chat and its user turn (from 1) the hint is showing under now. */
  shownThread: string | null;
  shownTurn: number | null;
  /** Close-button answers, ever, and the latest one's time. */
  dismissed: number;
  dismissedAt: number | null;
  /** The user moved a chat onto a top model from the hint or a retry. */
  switched: boolean;
}

export const EMPTY_TOP_MODEL_HINT_CARD: TopModelHintCard = {
  shown: 0,
  threads: [],
  shownThread: null,
  shownTurn: null,
  dismissed: 0,
  dismissedAt: null,
  switched: false,
};

/** Shown at most this many times in all, and once per chat. */
export const TOP_MODEL_HINT_MAX_SHOWN = 3;
/** Two closes end it; after one, it keeps quiet this long. */
export const TOP_MODEL_HINT_MAX_DISMISSED = 2;
export const TOP_MODEL_HINT_QUIET_MS = 14 * 24 * 60 * 60 * 1000;
/** From this share of the month's credits used, the credit cards own the moment. */
export const TOP_MODEL_HINT_CREDITS_SHARE = 0.5;
const TOP_MODEL_HINT_THREADS = 20;

/** The hint is on screen for this turn of this chat. */
export const topModelHintShowing = (
  card: TopModelHintCard | null | undefined,
  at: { threadId: string; turn: number }
): boolean =>
  card != null &&
  !card.switched &&
  card.shownThread === at.threadId &&
  card.shownTurn === at.turn;

/**
 * Whether a new hint may start in this chat now: never after a switch, three
 * showings or two closes; not within the quiet time after a close; once per
 * chat.
 */
export const topModelHintAllowed = (
  card: TopModelHintCard | null | undefined,
  at: { threadId: string; now: number }
): boolean => {
  const state = card ?? EMPTY_TOP_MODEL_HINT_CARD;
  return (
    !state.switched &&
    state.shown < TOP_MODEL_HINT_MAX_SHOWN &&
    state.dismissed < TOP_MODEL_HINT_MAX_DISMISSED &&
    (state.dismissedAt == null ||
      at.now - state.dismissedAt >= TOP_MODEL_HINT_QUIET_MS) &&
    !state.threads.includes(at.threadId)
  );
};

/** The record once the hint shows under this turn. */
export const topModelHintShown = (
  card: TopModelHintCard | null | undefined,
  at: { threadId: string; turn: number }
): TopModelHintCard => {
  const state = card ?? EMPTY_TOP_MODEL_HINT_CARD;
  return {
    ...state,
    shown: state.shown + 1,
    threads: [
      ...state.threads.filter((id) => id !== at.threadId),
      at.threadId,
    ].slice(-TOP_MODEL_HINT_THREADS),
    shownThread: at.threadId,
    shownTurn: at.turn,
  };
};

/** Credits used past the share where the credit cards take over; unknown is not past it. */
export const topModelHintCreditsSpent = (account: {
  credits_used?: number | null;
  credits_granted?: number | null;
}): boolean =>
  account.credits_used != null &&
  account.credits_granted != null &&
  account.credits_granted > 0 &&
  account.credits_used / account.credits_granted >=
    TOP_MODEL_HINT_CREDITS_SHARE;

/**
 * The hint's models, in button order: the plan's Sonnet, then its Opus, each
 * only when the account's catalog runs it now. Empty when neither does.
 */
export const topModelHintChoices = <
  T extends {
    id: string;
    label: string;
    configured?: boolean;
    access?: string;
  },
>(
  topModels: readonly string[],
  catalog: readonly T[]
): T[] => {
  const pick = (family: RegExp): T | null => {
    for (const name of topModels.filter((each) => family.test(each))) {
      const found = planCatalogModel(name, catalog, "runnable");
      if (found != null) return found;
    }
    return null;
  };
  return [pick(/sonnet/i), pick(/opus/i)].filter(
    (model): model is T => model != null
  );
};
