import { conversationRefFromKey } from "@abacus-ai/contract/conversation-scope";
import { useSyncExternalStore } from "react";

import { noticeSnapshot } from "#renderer/data/queries/notices";
import { useAppContext } from "#renderer/lib/use-app-context";

/** Sessions with a pending connector ask, apart from the turn's waiting level. */
export const useConnectorThreads = (): ReadonlySet<string> => {
  const asks = noticeSnapshot("connectors", useAppContext().transport);
  const snapshot = useSyncExternalStore(asks.subscribe, asks.get);
  return new Set(
    (snapshot?.requests ?? []).flatMap((request) => {
      const ref = conversationRefFromKey(request.conversationKey);
      return ref?.kind === "session" ? [ref.sessionId] : [];
    })
  );
};
