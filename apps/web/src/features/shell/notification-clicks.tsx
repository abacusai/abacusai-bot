import { useEffect } from "react";

import { followNotices } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import type { NotificationMetadata } from "#shared/contract";

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
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) => {
        const href = notificationHref(event.metadata);
        if (href != null) void navigate({ href });
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, navigate]);
  return null;
};
