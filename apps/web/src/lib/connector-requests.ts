import type { ConnectorsEvent } from "@abacus-ai/contract/contract/connectors";
import type {
  ConnectorOutcome,
  ConnectorRequest,
} from "@abacus-ai/contract/contracts";
import type { ConversationKey } from "@abacus-ai/contract/conversation-scope";
/**
 * Connector asks for the bot chat's banner (spec 03 §11.4) and for other
 * bots' attention (§6.1, §6.6), over `connectors.events` (lossless-
 * actionable; with a key, the first yield is a snapshot of the pending asks,
 * so a reopened iterator re-snapshots).
 *
 * Connecting runs the connector's flow (a platform connector's connect page,
 * then waiting for it to read connected), then answers `connected`. The
 * session's tools are main's to bring up to date, at its next turn start. A
 * cancelled flow answers `declined`.
 */
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

import { followNotices, noticeSnapshot } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";
import { ConnectAttempt } from "#renderer/lib/connect-page";
import { CONNECTED_PARAM } from "#renderer/lib/connect-target";

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
 * from the click itself: a page opens before any await. `signal` cancels the
 * attempt without answering.
 */
export const connectRequest = async (
  transport: Transport,
  request: ConnectorRequest,
  values?: Record<string, string>,
  signal?: AbortSignal
): Promise<ConnectResult> => {
  const { client } = transport;
  let outcome: ConnectorOutcome;
  if (values == null) {
    const attempt = new ConnectAttempt(transport, request.connectorId);
    signal?.addEventListener("abort", () => attempt.cancel(), { once: true });
    if (signal?.aborted) attempt.cancel();
    outcome = await attempt.result;
  } else
    try {
      outcome = await client.connectors.submitFields({
        connectorId: request.connectorId,
        values,
      });
    } catch (error) {
      return { kind: "error", message: messageOf(error) };
    }
  if (!outcome.ok) {
    if (outcome.cancelled === true) {
      // A cancel the caller asked for is answered by the caller, if at all.
      if (signal?.aborted !== true) await respond(client, request, "declined");
      return { kind: "declined" };
    }
    return { kind: "error", message: outcome.error };
  }
  return answerConnected(client, request);
};

/**
 * The ask answered `connected`. Nothing is refreshed here: main brings every
 * session's tools to the account's connectors at that session's next turn.
 */
const answerConnected = async (
  client: Client,
  request: ConnectorRequest
): Promise<ConnectResult> => {
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
  // Unmounting cancels the attempt; its answer then sets nothing.
  useEffect(
    () => () => {
      waiting.current?.abort();
      waiting.current = null;
    },
    []
  );

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

  // The host's connect route sent this tab back after consent: the ask for
  // that connector is answered here once the host reads it connected (the
  // parameter alone proves nothing), and the parameter leaves the URL.
  const returned = useRef<string | null>(null);
  useEffect(() => {
    const url = new URL(window.location.href);
    returned.current = url.searchParams.get(CONNECTED_PARAM);
    if (returned.current == null) return;
    url.searchParams.delete(CONNECTED_PARAM);
    window.history.replaceState(window.history.state, "", url);
  }, []);
  useEffect(() => {
    if (current == null || current.connectorId !== returned.current) return;
    returned.current = null;
    void (async () => {
      const statuses = await transport.client.connectors.statuses({});
      if (statuses[current.connectorId]?.state !== "connected") return;
      const result = await answerConnected(transport.client, current);
      if (result.kind === "error") setError(result.message);
      else
        setState((previous) => ({
          ...previous,
          requests: previous.requests.filter(
            (row) => row.requestId !== current.requestId
          ),
        }));
    })().catch((error: unknown) => setError(messageOf(error)));
  }, [current, transport]);

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
      void connectRequest(transport, current, values, abort.signal).then(
        (result) => {
          if (waiting.current !== abort) return;
          waiting.current = null;
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
    stop: () => {
      if (current == null || waiting.current == null) return;
      waiting.current.abort();
      void declineRequest(transport.client, current);
    },
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
