import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { useEffect } from "react";

import type { Db } from "#renderer/data/db";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import { updateDraft } from "#renderer/lib/continuity/composer-drafts";
import { markExternalOpen } from "#renderer/lib/navigation/external-open";
import { openTargetOptions } from "#renderer/lib/navigation/open-target-options";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { platformSystem } from "#renderer/lib/platform-system";

/** Missing kind retains the session-only behavior of older producers. */
export const notificationOptions = (metadata: NotificationMetadata) => {
  const sessionId = metadata.sessionId;
  switch (metadata.kind) {
    case "messaging":
      return { to: "/library/messaging" } as const;
    case "github-watch":
      return { to: "/routines" } as const;
    case "channel":
      return metadata.channelId == null
        ? null
        : ({
            to: "/bots/channels/$channelId",
            params: { channelId: metadata.channelId },
          } as const);
    case "bot":
      return metadata.botId == null
        ? null
        : openTargetOptions({ kind: "bot", botId: metadata.botId, sessionId });
    case "routine":
      return metadata.routineId == null || sessionId == null
        ? null
        : openTargetOptions({
            kind: "routine-run",
            routineId: metadata.routineId,
            sessionId,
          });
    default:
      return sessionId == null
        ? null
        : openTargetOptions({ kind: "session", sessionId });
  }
};

/** The most a notice puts in a composer. */
const NOTICE_DRAFT_MAX_CHARS = 500;

/** A notice's draft as plain text: control characters out, capped; null when nothing is left. */
export const noticeDraft = (text: unknown): string | null => {
  if (typeof text !== "string") return null;
  const plain = Array.from(text)
    .map((char) => {
      const code = char.codePointAt(0) ?? 0;
      if (code === 0x0a || code === 0x09) return " ";
      return code < 0x20 || (code >= 0x7f && code < 0xa0) ? "" : char;
    })
    .join("")
    .trim();
  return plain.length === 0
    ? null
    : Array.from(plain).slice(0, NOTICE_DRAFT_MAX_CHARS).join("");
};

/**
 * A notice's draft goes into its session's composer, never sent. What the user
 * already wrote there stays: the notice only fills an empty composer.
 */
export const placeNoticeDraft = (
  metadata: NotificationMetadata,
  place: typeof updateDraft = updateDraft
): void => {
  const text = noticeDraft(metadata.draft);
  if (text == null || metadata.sessionId == null) return;
  place(metadata.sessionId, (draft) =>
    draft.text.trim() === "" ? { ...draft, text } : draft
  );
};

/**
 * A notice with no kind names a session; one a bot owns opens in the bot:
 * its forever chat is the bot's page (`/bots/$botId`, the chats route has
 * no forever chat), any other at its chat.
 */
export const withOwner = (
  metadata: NotificationMetadata,
  db: Pick<Db, "collections">
): NotificationMetadata => {
  if (metadata.kind != null || metadata.sessionId == null) return metadata;
  const owner = db.collections.sessions.get(metadata.sessionId)?.owner;
  if (owner?.kind !== "bot") return metadata;
  if (owner.role !== "forever")
    return { ...metadata, kind: "bot", botId: owner.botId };
  const { sessionId: _forever, ...rest } = metadata;
  return { ...rest, kind: "bot", botId: owner.botId };
};

export const NotificationClicks = ({
  transport,
  db,
}: {
  transport: Transport;
  db: Pick<Db, "collections">;
}): null => {
  const navigate = useAppNavigate();
  useEffect(() => {
    const clicked = (event: Event) => {
      markExternalOpen();
      const metadata = (event as CustomEvent<NotificationMetadata>).detail;
      if (metadata) placeNoticeDraft(metadata);
      const options = metadata
        ? notificationOptions(withOwner(metadata, db))
        : null;
      if (options) void navigate({ ...options, transition: "nav-lateral" });
    };
    window.addEventListener("abacusai-bot:notification-clicked", clicked);
    const abort = new AbortController();
    followNotice(
      "system",
      transport,
      (event) => {
        // A web host's notices; Electron's main process shows its own.
        if (event.type === "notification") {
          void platformSystem(transport.client).notify({
            title: event.title,
            body: event.body,
          });
          return;
        }
        if (event.type !== "notification-clicked") return;
        markExternalOpen();
        placeNoticeDraft(event.metadata);
        const options = notificationOptions(withOwner(event.metadata, db));
        if (options != null)
          void navigate({ ...options, transition: "nav-lateral" });
      },
      abort.signal
    );
    return () => {
      abort.abort();
      window.removeEventListener("abacusai-bot:notification-clicked", clicked);
    };
  }, [transport, db, navigate]);
  return null;
};
