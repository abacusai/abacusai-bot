/**
 * Connector asks for the bot chat's banner (spec 03 §11.4) and for other
 * bots' attention (§6.1, §6.6), over `connectors.events` (lossless-
 * actionable; with a key, the first yield is a snapshot of the pending asks,
 * so a reopened iterator re-snapshots).
 *
 * Connecting runs the connector's flow, then refreshes the requesting
 * session's MCP servers and only then answers `connected`: the agent's next
 * act is a call to the new connector's tool (review r2 #5). A refresh that
 * fails is an error on the card and answers nothing; `success: false` is the
 * no-running-agent case and proceeds. A cancelled flow answers `declined`.
 */
import { useEffect, useState } from "react";

import { followNotices } from "#renderer/data/queries/live";
import type { Transport } from "#renderer/data/transport";
import type { ConnectorsEvent } from "#shared/contract/connectors";
import type { ConnectorRequest } from "#shared/contracts";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "#shared/conversation-scope";

type Client = Pick<Transport["client"], "connectors" | "mcp">;

/** The pending asks after one event (pure). */
export const reduceRequests = (
  requests: readonly ConnectorRequest[],
  event: ConnectorsEvent,
  conversationKey: string | null
): ConnectorRequest[] => {
  switch (event.type) {
    case "snapshot":
      return event.requests.filter(
        (request) =>
          conversationKey == null || request.conversationKey === conversationKey
      );
    case "request":
      if (
        (conversationKey != null &&
          event.request.conversationKey !== conversationKey) ||
        requests.some((row) => row.requestId === event.request.requestId)
      )
        return [...requests];
      return [...requests, event.request];
    case "cleared":
      return requests.filter((row) => row.requestId !== event.requestId);
    default:
      return [...requests];
  }
};

export type ConnectResult =
  | { kind: "connected" }
  | { kind: "declined" }
  | { kind: "error"; message: string };

const messageOf = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

/** Answer the ask (never throws: an answer that fails is logged by main). */
const respond = async (
  client: Client,
  request: ConnectorRequest,
  outcome: "connected" | "declined" | "failed",
  error?: string
): Promise<void> => {
  await client.connectors
    .respond({
      requestId: request.requestId,
      conversationKey: request.conversationKey,
      outcome,
      ...(error != null ? { error } : {}),
    })
    .catch(() => undefined);
};

const declineRequest = (
  client: Client,
  request: ConnectorRequest
): Promise<void> => respond(client, request, "declined");

/** The flow, the refresh of the requesting session, then the answer. */
export const connectRequest = async (
  client: Client,
  request: ConnectorRequest,
  values?: Record<string, string>
): Promise<ConnectResult> => {
  let outcome;
  try {
    outcome =
      values != null
        ? await client.connectors.submitFields({
            connectorId: request.connectorId,
            values,
          })
        : await client.connectors.connect({ connectorId: request.connectorId });
  } catch (error) {
    return { kind: "error", message: messageOf(error) };
  }
  if (!outcome.ok) {
    if (outcome.cancelled === true) {
      await respond(client, request, "declined");
      return { kind: "declined" };
    }
    return { kind: "error", message: outcome.error };
  }
  const ref = conversationRefFromKey(
    request.conversationKey as ConversationKey
  );
  if (ref?.kind === "session") {
    try {
      // `success: false`: no agent process is running; the next start reads
      // the connector from disk.
      const refreshed = await client.mcp.refresh({
        workspaceId: ref.workspaceId,
        sessionId: ref.sessionId,
      });
      if (
        !refreshed.success &&
        refreshed.error &&
        refreshed.error !== "CLI session is not running."
      )
        return { kind: "error", message: refreshed.error };
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  }
  await respond(client, request, "connected");
  return { kind: "connected" };
};

export interface ConnectorRequestsState {
  /** The ask on screen (the oldest pending for this conversation). */
  current: ConnectorRequest | null;
  busy: boolean;
  error: string | null;
  connect(values?: Record<string, string>): void;
  decline(): void;
  stop(): void;
}

/** This conversation's pending asks and the card's actions. */
export const useConnectorRequests = (
  transport: Transport,
  conversationKey: string | null
): ConnectorRequestsState => {
  // Keyed by conversation: another conversation's list is never shown.
  const [state, setState] = useState<{
    key: string | null;
    requests: ConnectorRequest[];
  }>({ key: null, requests: [] });
  const requests = state.key === conversationKey ? state.requests : [];
  const setRequests = (
    update: (previous: ConnectorRequest[]) => ConnectorRequest[]
  ): void =>
    setState((previous) => ({
      key: conversationKey,
      requests: update(
        previous.key === conversationKey ? previous.requests : []
      ),
    }));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (conversationKey == null) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) =>
        transport.client.connectors.events(
          { conversationKey: conversationKey as ConversationKey },
          { signal }
        ),
      (event) =>
        setState((previous) => ({
          key: conversationKey,
          requests: reduceRequests(
            previous.key === conversationKey ? previous.requests : [],
            event,
            conversationKey
          ),
        })),
      abort.signal
    );
    return () => abort.abort();
  }, [transport, conversationKey]);

  const current = requests[0] ?? null;
  const drop = (request: ConnectorRequest): void =>
    setRequests((previous) =>
      previous.filter((row) => row.requestId !== request.requestId)
    );

  return {
    current,
    busy,
    error,
    connect: (values) => {
      if (current == null || busy) return;
      setBusy(true);
      setError(null);
      void connectRequest(transport.client, current, values).then((result) => {
        setBusy(false);
        if (result.kind === "error") setError(result.message);
        else drop(current);
      });
    },
    decline: () => {
      if (current == null) return;
      setError(null);
      drop(current);
      void declineRequest(transport.client, current);
    },
    stop: () => {
      void transport.client.connectors.cancelConnect({}).catch(() => undefined);
    },
  };
};

/** Pending asks per conversation key, from the keyless stream (attention). */
const reduceAskCounts = (
  asks: ReadonlyMap<string, string>,
  event: ConnectorsEvent
): Map<string, string> => {
  const next = new Map(asks);
  if (event.type === "snapshot") {
    next.clear();
    for (const request of event.requests)
      next.set(request.requestId, request.conversationKey);
  } else if (event.type === "request")
    next.set(event.request.requestId, event.request.conversationKey);
  else if (event.type === "cleared") next.delete(event.requestId);
  return next;
};

const countAsks = (
  asks: ReadonlyMap<string, string>
): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const key of asks.values()) counts[key] = (counts[key] ?? 0) + 1;
  return counts;
};

/** `Record<conversationKey, pending asks>` for every conversation. */
export const usePendingConnectorAsks = (
  transport: Transport
): Record<string, number> => {
  const [asks, setAsks] = useState<ReadonlyMap<string, string>>(
    () => new Map()
  );
  useEffect(() => {
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.connectors.events({}, { signal }),
      (event) => setAsks((previous) => reduceAskCounts(previous, event)),
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  return countAsks(asks);
};
