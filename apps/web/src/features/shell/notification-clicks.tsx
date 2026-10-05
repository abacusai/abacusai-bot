import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { useEffect } from "react";

import { followNotices } from "#renderer/data/queries/live";
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

export const NotificationClicks = ({
  transport,
}: {
  transport: Transport;
}): null => {
  const navigate = useAppNavigate();
  useEffect(() => {
    const clicked = (event: Event) => {
      const metadata = (event as CustomEvent<NotificationMetadata>).detail;
      const href = metadata ? notificationHref(metadata) : null;
      if (href) void navigate({ href });
    };
    window.addEventListener("abacusai-bot:notification-clicked", clicked);
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) => {
        // A web host's notices; Electron's main process shows its own.
        if (event.type === "notification") {
          void platformSystem(transport.client).notify({
            title: event.title,
            body: event.body,
          });
          return;
        }
        const href = notificationHref(event.metadata);
        if (href != null) void navigate({ href });
      },
      abort.signal
    );
    return () => {
      abort.abort();
      window.removeEventListener("abacusai-bot:notification-clicked", clicked);
    };
  }, [transport, navigate]);
  return null;
};
