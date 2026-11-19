/**
 * A new user's first days in the app: a big ask in their own chat gets a
 * first look before the full build (the agent's first-look.ts).
 */

/** How long the first look stays on. */
export const FIRST_LOOK_DAYS_MS = 2 * 24 * 60 * 60_000;

/**
 * Whether the user is in their first days, from their oldest chat. Chats are
 * kept per account (a sign-out moves them aside), and onboarding opens the
 * first one at once, so the oldest is when this account started here. No
 * chat yet is day one.
 */
export const inFirstDays = (
  chats: readonly { createdAt: string }[],
  now: number = Date.now()
): boolean => {
  const first = Math.min(
    ...chats
      .map((chat) => Date.parse(chat.createdAt))
      .filter((at) => Number.isFinite(at))
  );
  return first === Infinity || now - first < FIRST_LOOK_DAYS_MS;
};
