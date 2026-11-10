/**
 * The next step: when a chat finishes a piece of work, its reply ends on one
 * question and the buttons that answer it, and a task that repeats can become
 * a routine.
 */
import {
  DELIVERABLE_OFFER_MAX_MISSES,
  type DeliverableOfferCard,
  deliverableOfferIgnored,
} from "./deliverable-offer";

/** The renderer's record (prefs `dismissals.nextStepOffer`): the deliverable offer's, with no close button. */
export type NextStepCard = DeliverableOfferCard;

/**
 * Whether the offer `offerId`, on turn `turn` of `threadId`, may show: never
 * on the reply right after one left unanswered, and never once three in a row
 * were passed over. A tapped offer leads straight to the next one.
 */
export const nextStepAllowed = (
  card: NextStepCard | null | undefined,
  offer: { id: string; threadId: string; turn: number }
): boolean => {
  if (card == null) return true;
  const ignored = deliverableOfferIgnored(card, offer.id);
  const followsUnanswered =
    ignored &&
    card.shownThread === offer.threadId &&
    card.shownTurn != null &&
    offer.turn === card.shownTurn + 1;
  return (
    card.misses + (ignored ? 1 : 0) < DELIVERABLE_OFFER_MAX_MISSES &&
    !followsUnanswered
  );
};

/** Past this share of a free grant, the credits are left for what the user asks. */
const ROUTINE_OFFER_MAX_USED = 0.8;

/** A routine spends credits on every run: none offered near the end of a free grant. */
export const routineOfferClosed = (
  used: number | null | undefined,
  granted: number | null | undefined
): boolean =>
  used != null &&
  granted != null &&
  granted > 0 &&
  used / granted >= ROUTINE_OFFER_MAX_USED;
