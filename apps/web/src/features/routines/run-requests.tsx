import type {
  ConnectorRequest,
  ConnectorOutcome,
} from "@abacus-ai/contract/contracts";
import { conversationRefFromKey } from "@abacus-ai/contract/conversation-scope";
import { useState, useSyncExternalStore } from "react";

import { ConnectorRequestCard } from "#renderer/components/connector-request-card";
import { noticeSnapshot } from "#renderer/data/queries/notices";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
/** The pending connector asks of these run sessions, one card each. */
export const RunRequests = ({
  sessionIds,
  className,
  connect,
  cancel,
}: {
  sessionIds: ReadonlySet<string>;
  className?: string;
  connect(
    id: string,
    values?: Record<string, string>
  ): Promise<ConnectorOutcome>;
  cancel(): Promise<void>;
}) => {
  const { transport } = useAppContext();
  const asks = noticeSnapshot("connectors", transport);
  const snapshot = useSyncExternalStore(asks.subscribe, asks.get);
  const requests = (snapshot?.requests ?? []).flatMap((request) => {
    const ref = conversationRefFromKey(request.conversationKey);
    return ref?.kind === "session" && sessionIds.has(ref.sessionId)
      ? [{ request, workspaceId: ref.workspaceId, sessionId: ref.sessionId }]
      : [];
  });
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const respond = async (
    request: ConnectorRequest,
    outcome: "connected" | "declined" | "failed",
    error?: string
  ) =>
    transport.client.connectors.respond({
      requestId: request.requestId,
      conversationKey: request.conversationKey,
      outcome,
      ...(error ? { error } : {}),
    });
  const accept = async (
    { request, workspaceId, sessionId }: (typeof requests)[number],
    values?: Record<string, string>
  ) => {
    setBusy(request.requestId);
    setError(null);
    await (async () => {
      try {
        const result = await connect(request.connectorId, values);
        if (result.ok) {
          // Connected whatever this says: the run is usually over, and the
          // next one starts with the tools.
          await transport.client.mcp
            .refresh({ workspaceId, sessionId })
            .catch(() => undefined);
          await respond(request, "connected");
        } else if (result.cancelled) await respond(request, "declined");
        else {
          setError(result.error);
          await respond(request, "failed", result.error);
        }
      } catch (e) {
        const error = errorText(e);
        setError(error);
        await respond(request, "failed", error).catch(() => undefined);
      }
    })().finally(() => {
      setBusy(null);
    });
  };
  return (
    <>
      {requests.map((ask) => (
        <ConnectorRequestCard
          key={ask.request.requestId}
          request={ask.request}
          className={className}
          busy={busy === ask.request.requestId}
          error={error}
          onConnect={(values) => void accept(ask, values)}
          onConnected={() =>
            void respond(ask.request, "connected").catch((e) =>
              setError(errorText(e))
            )
          }
          onDecline={() =>
            void respond(ask.request, "declined").catch((e) =>
              setError(errorText(e))
            )
          }
          onStop={() => void cancel()}
        />
      ))}
    </>
  );
};
