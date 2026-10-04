import { useEffect, useState } from "react";

import { ConnectorRequestCard } from "#renderer/components/connector-request-card";
import { followNotices } from "#renderer/data/queries/live";
import { useAppContext, errorText } from "#renderer/lib/use-app-context";
import type { ConnectorRequest, ConnectorOutcome } from "#shared/contracts";
import { sessionConversationKey } from "#shared/conversation-scope";
export const RunRequests = ({
  sessionId,
  workspaceId,
  connect,
  cancel,
}: {
  sessionId: string;
  workspaceId: string;
  connect(
    id: string,
    values?: Record<string, string>
  ): Promise<ConnectorOutcome>;
  cancel(): Promise<void>;
}) => {
  const { transport } = useAppContext();
  const [requests, setRequests] = useState<ConnectorRequest[]>([]);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const conversationKey = sessionConversationKey(workspaceId, sessionId);
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.connectors.events({ conversationKey }, { signal }),
      (event) => {
        if (event.type === "snapshot") setRequests(event.requests);
        if (event.type === "request")
          setRequests((rows) =>
            rows.some((r) => r.requestId === event.request.requestId)
              ? rows
              : [...rows, event.request]
          );
        if (event.type === "cleared")
          setRequests((rows) =>
            rows.filter((r) => r.requestId !== event.requestId)
          );
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport, conversationKey]);
  const respond = async (
    request: ConnectorRequest,
    outcome: "connected" | "declined" | "failed",
    error?: string
  ) =>
    transport.client.connectors.respond({
      requestId: request.requestId,
      conversationKey,
      outcome,
      ...(error ? { error } : {}),
    });
  const accept = async (
    request: ConnectorRequest,
    values?: Record<string, string>
  ) => {
    setBusy(request.requestId);
    setError(null);
    await (async () => {
      try {
        const result = await connect(request.connectorId, values);
        if (result.ok) {
          const refreshed = await transport.client.mcp.refresh({
            workspaceId,
            sessionId,
          });
          if (!refreshed.success) {
            const error = refreshed.error ?? "Refresh failed";
            setError(error);
            await respond(request, "failed", error);
            return;
          }
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
      {requests.map((request) => (
        <ConnectorRequestCard
          key={request.requestId}
          request={request}
          busy={busy === request.requestId}
          error={error}
          onConnect={(values) => void accept(request, values)}
          onDecline={() =>
            void respond(request, "declined").catch((e) =>
              setError(errorText(e))
            )
          }
          onStop={() => void cancel()}
        />
      ))}
    </>
  );
};
