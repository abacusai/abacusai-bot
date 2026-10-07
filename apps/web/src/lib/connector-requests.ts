import { connectorById } from "@abacus-ai/connectors/registry";
import type { ConnectorsEvent } from "@abacus-ai/contract/contract/connectors";
import type {
  ConnectorOutcome,
  ConnectorRequest,
} from "@abacus-ai/contract/contracts";
import {
  conversationRefFromKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
/**
 * Connector asks for the bot chat's banner (spec 03 §11.4) and for other
 * bots' attention (§6.1, §6.6), over `connectors.events` (lossless-
 * actionable; with a key, the first yield is a snapshot of the pending asks,
 * so a reopened iterator re-snapshots).
 *
 * Connecting runs the connector's flow (a platform connector's connect page,
 * then waiting for it to read connected), then refreshes the requesting
 * session's MCP servers and only then answers `connected`: the agent's next
 * act is a call to the new connector's tool (review r2 #5). A refresh that
 * fails is an error on the card and answers nothing; `success: false` is the
 * no-running-agent case and proceeds. A cancelled flow answers `declined`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { followNotices, noticeSnapshot } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import { opensConnectTab, waitForConnected } from "#renderer/lib/connect-page";
import { openConnectPage } from "#renderer/lib/platform-system";

type Client = Pick<Transport["client"], "connectors" | "mcp" | "system">;

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

/**
 * The flow, the refresh of the requesting session, then the answer. Call it
 * from the click itself: a platform connector's page opens before any await.
 * `signal` stops waiting on that page (answered as declined).
 */
export const connectRequest = async (
  client: Client,
  request: ConnectorRequest,
  values?: Record<string, string>,
  signal: AbortSignal = new AbortController().signal
): Promise<ConnectResult> => {
  const opened =
    values == null && opensConnectTab(connectorById(request.connectorId))
      ? openConnectPage(client, request.connectorId)
      : null;
  let outcome: ConnectorOutcome;
  try {
    if (opened != null) {
      outcome = await opened;
      if (outcome.ok)
        outcome = await waitForConnected(client, request.connectorId, signal);
    } else
      outcome =
        values != null
          ? await client.connectors.submitFields({
              connectorId: request.connectorId,
              values,
            })
          : await client.connectors.connect({
              connectorId: request.connectorId,
            });
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
  const waiting = useRef<AbortController | null>(null);

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
      const abort = new AbortController();
      waiting.current = abort;
      void connectRequest(transport.client, current, values, abort.signal).then(
        (result) => {
          if (waiting.current === abort) waiting.current = null;
          setBusy(false);
          if (result.kind === "error") setError(result.message);
          else drop(current);
        }
      );
    },
    decline: () => {
      if (current == null) return;
      setError(null);
      drop(current);
      void declineRequest(transport.client, current);
    },
    stop: () => waiting.current?.abort(),
  };
};

/** `Record<conversationKey, pending asks>` for every conversation. */
export const usePendingConnectorAsks = (
  transport: Transport
): Record<string, number> => {
  const asks = noticeSnapshot("connectors", transport);
  const snapshot = useSyncExternalStore(asks.subscribe, asks.get);
  const counts: Record<string, number> = {};
  for (const { conversationKey } of snapshot?.requests ?? [])
    counts[conversationKey] = (counts[conversationKey] ?? 0) + 1;
  return counts;
};
