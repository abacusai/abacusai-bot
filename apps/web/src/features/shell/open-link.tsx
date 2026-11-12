/**
 * `abacusaibot://open` links (contract open-link.ts), once the user is signed
 * in: main holds the latest link and this takes it, at mount and whenever
 * main says one arrived. A chat this app has opens with the link's text in
 * its composer, never sent; anything else opens home.
 */
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import type { OpenLink } from "@abacus-ai/contract/open-link";
import { useEffect } from "react";

import type { Db } from "#renderer/data/db";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import {
  type Draft,
  updateDraft,
} from "#renderer/lib/continuity/composer-drafts";
import { markExternalOpen } from "#renderer/lib/navigation/external-open";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

import { notificationOptions, withOwner } from "./notification-clicks";

const HOME = { to: "/bots/new" } as const;

/** A chat a link may open: one the user has, not a routine's run or an editor turn. */
const openable = (row: SessionRow | undefined): boolean =>
  row != null && row.routineId == null && row.editorFor == null;

/** Where a link to `sessionId` lands: its chat (a bot's opens in its bot), else home. */
export const chatTarget = (
  sessionId: string | null,
  db: Pick<Db, "collections">
) => {
  const row =
    sessionId == null ? undefined : db.collections.sessions.get(sessionId);
  const options =
    sessionId != null && openable(row)
      ? notificationOptions(withOwner({ sessionId }, db))
      : null;
  return options == null
    ? { options: HOME, sessionId: null }
    : { options, sessionId: sessionId! };
};

/** The composer with `text` in it, or null when the user already typed there. */
export const draftWithText = (
  current: Draft | undefined,
  text: string
): Draft | null =>
  current != null && current.text.trim().length > 0
    ? null
    : {
        ...(current ?? { attachments: [] }),
        text,
        selectionStart: text.length,
        selectionEnd: text.length,
      };

/** Opens the chat (else home), with `text` waiting in its composer. */
export const openChatWithText = (
  sessionId: string | null,
  text: string | null,
  db: Pick<Db, "collections">,
  navigate: ReturnType<typeof useAppNavigate>
): void => {
  const target = chatTarget(sessionId, db);
  // Only an empty composer takes it: what the user wrote there stays.
  if (target.sessionId != null && text != null)
    updateDraft(
      target.sessionId,
      (draft) => draftWithText(draft, text) ?? draft
    );
  void navigate({ ...target.options, transition: "nav-lateral" });
};

export const OpenLinkHost = ({
  transport,
  db,
}: {
  transport: Transport;
  db: Pick<Db, "collections">;
}): null => {
  const navigate = useAppNavigate();
  useEffect(() => {
    const abort = new AbortController();
    const take = async (): Promise<void> => {
      const link: OpenLink | null = await transport.client.system
        .takeOpenLink({})
        .catch(() => null);
      if (link == null) return;
      markExternalOpen();
      await db.collections.sessions.preload().catch(() => undefined);
      openChatWithText(link.sessionId, link.draft, db, navigate);
    };
    void take();
    followNotice(
      "system",
      transport,
      (event) => {
        if (event.type !== "open-link") return;
        markExternalOpen();
        void take();
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, db, navigate]);
  return null;
};
