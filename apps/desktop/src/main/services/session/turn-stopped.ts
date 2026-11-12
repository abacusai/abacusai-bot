/**
 * A turn the user stopped (Stop in that chat), as a waiter for its text
 * learns it: told apart from a failure, so channel work stopped in the bot's
 * own chat is shown as stopped and wakes nobody to redo it.
 */
export class TurnStoppedError extends Error {}
