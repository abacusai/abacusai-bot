/**
 * The deliverable offer: under a long, structured answer that handed over no
 * file, one row offering to turn it into a document the user can keep. The
 * renderer reads it off the reply on screen; a tap sends the request as the
 * user's next message, and the file arrives on the turn's deliverables card.
 */

/** Which button the reply gets: a report for research-shaped answers. */
export const DELIVERABLE_OFFER_KINDS = ["doc", "report"] as const;
export type DeliverableOfferKind = (typeof DELIVERABLE_OFFER_KINDS)[number];

/** The renderer's record (prefs `dismissals.deliverableOffer`). */
export interface DeliverableOfferCard {
  /** The reply last offered on (its message id), and where it was. */
  shownOffer: string | null;
  shownThread: string | null;
  /** The user turn of that thread the reply answered, counted from 1. */
  shownTurn: number | null;
  /** The offer last tapped or closed. */
  answered: string | null;
  /** Offers closed or left unanswered since the last tap. */
  misses: number;
  /** Close-button answers, ever. */
  dismissed: number;
}

export const EMPTY_DELIVERABLE_OFFER_CARD: DeliverableOfferCard = {
  shownOffer: null,
  shownThread: null,
  shownTurn: null,
  answered: null,
  misses: 0,
  dismissed: 0,
};

/** Three offers in a row passed over and it stops. */
export const DELIVERABLE_OFFER_MAX_MISSES = 3;
/** Two closes and it stops. */
export const DELIVERABLE_OFFER_MAX_DISMISSED = 2;

/** The shown offer was left without an answer and another reply came. */
export const deliverableOfferIgnored = (
  card: DeliverableOfferCard | null | undefined,
  offerId: string
): boolean =>
  card?.shownOffer != null &&
  card.shownOffer !== offerId &&
  card.answered !== card.shownOffer;

/**
 * Whether a new offer may show for the reply `offerId`, the answer to turn
 * `turn` of `threadId`: under both caps, counting a pending unanswered offer
 * as a miss, and never on the reply right after the last one offered on.
 */
export const deliverableOfferAllowed = (
  card: DeliverableOfferCard | null | undefined,
  offer: { id: string; threadId: string; turn: number }
): boolean => {
  if (card == null) return true;
  const misses =
    card.misses + (deliverableOfferIgnored(card, offer.id) ? 1 : 0);
  const followsLast =
    card.shownThread === offer.threadId &&
    card.shownTurn != null &&
    offer.turn === card.shownTurn + 1;
  return (
    misses < DELIVERABLE_OFFER_MAX_MISSES &&
    card.dismissed < DELIVERABLE_OFFER_MAX_DISMISSED &&
    !followsLast
  );
};

// ─── what the reply looks like ──────────────────────────────────────────

/** Shorter than this, an answer is a chat reply, not a piece of work. */
const MIN_PROSE = 1200;
/** Longer than this, it is a piece of work even without headings or lists. */
const LONG_PROSE = 2400;

const FENCE = /```[\s\S]*?(?:```|$)/g;
const HEADING = /^\s{0,3}(?:#{1,4}\s+\S|\*\*[^*\n]{2,80}\*\*:?\s*$)/;
const LIST_ITEM = /^\s*(?:[-*+•]|\d{1,2}[.)])\s+\S/;
const TABLE_ROW = /^\s*\|.*\|\s*$/;
/** Kana, CJK ideographs and Hangul carry about a word per character. */
const DENSE_SCRIPT = /[぀-ヿ㐀-鿿가-힯]/g;

const weightedLength = (text: string): number =>
  text.replace(/\s+/g, " ").trim().length +
  (text.match(DENSE_SCRIPT)?.length ?? 0);

/**
 * The button a finished reply's text earns, or null: long prose (code blocks
 * aside) with headings, a list or a table, or very long prose. A reply that
 * is mostly code belongs in the editor, not a document. A table or several
 * sections read as a report, anything else as a doc.
 */
export const deliverableOfferKind = (
  text: string
): DeliverableOfferKind | null => {
  const code = (text.match(FENCE) ?? []).join("");
  const prose = text.replace(FENCE, "");
  const length = weightedLength(prose);
  if (length < MIN_PROSE || weightedLength(code) > length) return null;
  let headings = 0;
  let items = 0;
  let rows = 0;
  for (const line of prose.split("\n")) {
    if (TABLE_ROW.test(line)) rows += 1;
    else if (HEADING.test(line)) headings += 1;
    else if (LIST_ITEM.test(line)) items += 1;
  }
  const table = rows >= 3;
  const structured = table || headings >= 2 || items >= 4;
  if (!structured && length < LONG_PROSE) return null;
  return table || headings >= 3 ? "report" : "doc";
};
