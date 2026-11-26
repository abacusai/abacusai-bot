/**
 * `hand_off_session`'s rules, apart from ServiceHost: its caps, the note a
 * handed-off chat opens on, and how its last turn ended for the source's card.
 */
import { appNoteTag } from "@abacus-ai/agent/user-text";
import type { HandOffEnd } from "@abacus-ai/contract/contracts";

import type { TurnEnd } from "./turn-ledger";

/** How many chats handed off from one chat may be working at once. */
export const HANDOFFS_WORKING_MAX = 3;
/** How many chats one message of a chat may hand work off to. */
export const HANDOFFS_PER_TURN_MAX = 3;
/** How many chats one chat may hand work off to in a day. */
export const HANDOFFS_PER_DAY_MAX = 10;

/** The checkout a hand-off made for its chat, which goes when the chat does. */
export interface HandOffCheckout {
  path: string;
  branch: string | null;
  /** The commit it was made from: a branch still on it has nothing of its own. */
  base: string;
}

/** What `hand_off_session` started, or why it did not. */
export type HandOffResult =
  | {
      sessionId: string;
      /** No checkout of its own: it works in the same folder as its source. */
      sharedFolder: boolean;
    }
  | { error: string };

/**
 * A handed-off chat's first message: the app's note, then the brief its
 * source's agent wrote. Never the user's own words (its tag says so).
 */
export const handOffNote = (
  from: string,
  ownCheckout: boolean,
  brief: string
): string =>
  [
    `${appNoteTag("handed off")} The user's chat "${from}" handed this task off to you, to run here beside it. Its agent wrote the brief below; it is not the user's own message.`,
    ownCheckout
      ? "You work in a checkout of your own, made from that chat's last commit: its uncommitted changes are not here, and neither are installed dependencies or build output (node_modules, virtual environments and the like), so install them before the first build or test."
      : "That chat's agent works in the same folder at the same time: do not edit or delete files it may be working on, and say so here if the work overlaps.",
    "Do not hand this task off again. Ask the user here if anything is unclear.",
    "",
    brief,
  ].join("\n");

/** How a turn's ending reads on the source's card. */
export const handOffEndOf = (end: TurnEnd): HandOffEnd =>
  end === "reply"
    ? "done"
    : end === "stopped" || end === "app_closed"
      ? "stopped"
      : "failed";
