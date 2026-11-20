import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { useLiveQuery } from "@tanstack/react-db";

import { useCollections } from "#renderer/data/db";
import { isListedSession } from "#renderer/data/db/filters";

/** The newest of the user's own named chats: never a routine run's or a bot's. */
export const currentChat = (
  sessions: readonly SessionRow[]
): SessionRow | null =>
  sessions
    .filter(
      (session) => isListedSession(session) && session.label.trim().length > 0
    )
    .reduce<SessionRow | null>(
      (latest, session) =>
        latest == null || session.updatedAt > latest.updatedAt
          ? session
          : latest,
      null
    );

/**
 * The chat the user worked in last, which the credit surfaces name as what
 * running out would stop, and whether any chat is mid-turn.
 */
export const useCurrentChat = (): {
  chat: SessionRow | null;
  turnRunning: boolean;
} => {
  const collections = useCollections();
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ s: collections.sessions })
  );
  const rows = sessions ?? [];
  return {
    chat: currentChat(rows),
    turnRunning: rows.some((session) => session.turn?.isBusy === true),
  };
};
