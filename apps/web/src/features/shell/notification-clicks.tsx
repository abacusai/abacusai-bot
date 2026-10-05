import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { useEffect } from "react";

import type { Db } from "#renderer/data/db";
import { followNotice } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { platformSystem } from "#renderer/lib/platform-system";

/** Missing kind retains the session-only behavior of older producers. */
export const notificationHref = (
  metadata: NotificationMetadata
): string | null => {
  const session =
    metadata.sessionId == null ? null : encodeURIComponent(metadata.sessionId);
  switch (metadata.kind) {
    case "bot":
      return metadata.botId == null
        ? null
        : `/bots/${encodeURIComponent(metadata.botId)}${session == null ? "" : `/chats/${session}`}`;
    case "routine":
      return metadata.routineId == null || session == null
        ? null
        : `/routines/${encodeURIComponent(metadata.routineId)}?run=${session}`;
    default:
      return session == null ? null : `/sessions/${session}`;
  }
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
      const metadata = (event as CustomEvent<NotificationMetadata>).detail;
      const href = metadata ? notificationHref(withOwner(metadata, db)) : null;
      if (href) void navigate({ href, transition: "nav-lateral" });
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
        const href = notificationHref(withOwner(event.metadata, db));
        if (href != null) void navigate({ href, transition: "nav-lateral" });
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
