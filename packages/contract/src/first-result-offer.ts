/**
 * The onboarding offer test's held offer (billing plan `onboardingOffer`
 * after_first_result): onboarding skips its plan offer screen and the same
 * offer shows once, as a card under the account's first finished result. The
 * renderer stamps the mark (prefs `dismissals.firstResultOffer`) when it holds
 * the screen back, and answers it there.
 */

export interface FirstResultOfferMark {
  /** When onboarding held the screen back. */
  heldAt: number;
  /** The reply the card showed under; it stays on that reply until answered. */
  shownOn: string | null;
  /** Upgrade, Not now, or passed: the chat moved on to another reply unanswered. */
  answered: "upgrade" | "skip" | "passed" | null;
}

/** The held offer is still owed: its card is yet to be answered. */
export const firstResultOfferPending = (
  mark: FirstResultOfferMark | null | undefined
): boolean => mark != null && mark.answered == null;
