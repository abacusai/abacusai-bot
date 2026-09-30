import type { QueryClient } from "@tanstack/react-query";
/**
 * The bots area's notice streams (spec 03 §6.1), one subscription each per
 * document: main's `ai.attention` (per-thread asks), keyless
 * `connectors.events` (asks in every conversation + status changes),
 * `bots.events`, `messaging.events`, `memory.events` (query invalidation),
 * and the collection changes that also feed derived queries (a new sender
 * session, a bot rename).
 */
import { Store, useSelector } from "@tanstack/react-store";

import type { Collections } from "#next/data/db";
import { followNotices } from "#next/data/queries/live";
import type { Transport } from "#next/data/transport";
import type { AttentionEvent } from "#shared/contract/ai";
import {
  conversationRefFromKey,
  sessionConversationKey,
  type ConversationKey,
} from "#shared/conversation-scope";

import type { ThreadAttention } from "./attention";
import { botsQueries } from "./queries";

// ── ai.attention ─────────────────────────────────────────────────────────

const permissionsStore = new Store<Record<string, ThreadAttention>>({});

const applyAttentionEvent = (
  state: Record<string, ThreadAttention>,
  event: AttentionEvent
): Record<string, ThreadAttention> => {
  const toEntry = (item: {
    questions: number;
    approvals: number;
    firstTitle: string | null;
    oldestAt: number;
  }): ThreadAttention => ({
    count: item.questions + item.approvals,
    firstTitle: item.firstTitle,
    oldestAt: item.oldestAt,
  });
  if (event.type === "snapshot")
    return Object.fromEntries(
      event.items.map((item) => [item.threadId, toEntry(item)])
    );
  if (event.type === "upsert")
    return { ...state, [event.item.threadId]: toEntry(event.item) };
  const { [event.threadId]: _removed, ...rest } = state;
  return rest;
};

export const usePermissions = (): Record<string, ThreadAttention> =>
  useSelector(permissionsStore, (state) => state);

// ── connector asks (keyless) ─────────────────────────────────────────────

/** Pending asks: request id → session id (sessions only; drafts ignored). */
export const connectorAsksStore = new Store<Record<string, string>>({});

const sessionOfKey = (key: ConversationKey): string | null => {
  const ref = conversationRefFromKey(key);
  return ref?.kind === "session" ? ref.sessionId : null;
};

const asksBySession = (
  asks: Readonly<Record<string, string>>
): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const sessionId of Object.values(asks))
    out[sessionId] = (out[sessionId] ?? 0) + 1;
  return out;
};

export const useConnectorAsks = (): Record<string, number> =>
  asksBySession(useSelector(connectorAsksStore, (state) => state));

// ── the bridge ───────────────────────────────────────────────────────────

/**
 * Opens every stream above until `signal` aborts. Invalidation follows the
 * §6.1 table: each derived query lists every source of change (R3-T5).
 */
export const followBotsSources = (
  deps: {
    transport: Transport;
    queryClient: Pick<QueryClient, "invalidateQueries">;
    collections: Pick<Collections, "sessions" | "bots">;
    onConnectorAsk?(sessionId: string, requestId: string): void;
  },
  signal: AbortSignal
): void => {
  const { transport, queryClient, collections } = deps;
  const queries = botsQueries(transport.orpc);
  const invalidate = (options: { queryKey: readonly unknown[] }): void =>
    void queryClient.invalidateQueries({ queryKey: options.queryKey });

  void followNotices(
    transport,
    ({ signal: s }) => transport.client.ai.attention({}, { signal: s }),
    (event) =>
      permissionsStore.setState((state) => applyAttentionEvent(state, event)),
    signal
  );

  const cleared = new Set<string>();
  void followNotices(
    transport,
    ({ signal: s }) => {
      cleared.clear();
      connectorAsksStore.setState(() => ({}));
      const stream = transport.client.connectors.events({}, { signal: s });
      // Keyless events do not snapshot. Restore every known session's asks,
      // including bots whose transcripts have never been mounted.
      void collections.sessions
        .preload()
        .then(async () => {
          await Promise.all(
            collections.sessions.toArray.map(async (session) => {
              if (s.aborted) return;
              const requests = await transport.client.connectors.requests(
                {
                  conversationKey: sessionConversationKey(
                    session.workspaceId,
                    session.id
                  ),
                },
                { signal: s }
              );
              if (s.aborted) return;
              connectorAsksStore.setState((state) => ({
                ...state,
                ...Object.fromEntries(
                  requests
                    .filter((request) => !cleared.has(request.requestId))
                    .map((request) => [request.requestId, session.id])
                ),
              }));
            })
          );
        })
        .catch(() => undefined);
      return stream;
    },
    (event) => {
      if (event.type === "status-changed") {
        invalidate(queries.connectorStatuses());
        return;
      }
      if (event.type === "request") {
        const sessionId = sessionOfKey(event.request.conversationKey);
        if (sessionId != null) {
          deps.onConnectorAsk?.(sessionId, event.request.requestId);
          connectorAsksStore.setState((state) => ({
            ...state,
            [event.request.requestId]: sessionId,
          }));
        }
        return;
      }
      if (event.type === "cleared") {
        cleared.add(event.requestId);
        connectorAsksStore.setState((state) => {
          if (!(event.requestId in state)) return state;
          const { [event.requestId]: _gone, ...rest } = state;
          return rest;
        });
      }
    },
    signal
  );

  void followNotices(
    transport,
    ({ signal: s }) => transport.client.bots.events({}, { signal: s }),
    () => invalidate(queries.chatPreviews()),
    signal
  );
  void followNotices(
    transport,
    ({ signal: s }) => transport.client.messaging.events({}, { signal: s }),
    () => {
      invalidate(queries.senderChats());
      invalidate(queries.messaging());
    },
    signal
  );
  void followNotices(
    transport,
    ({ signal: s }) => transport.client.memory.events({}, { signal: s }),
    () => invalidate(queries.memoryBots()),
    signal
  );

  // A new or removed sender session is a new sender chat; a rename
  // changes `BotMemoryView.name`.
  const sessions = collections.sessions.subscribeChanges((changes) => {
    if (
      changes.some(
        (change) =>
          (change.type === "insert" || change.type === "delete") &&
          change.value?.owner?.role === "sender"
      )
    )
      invalidate(queries.senderChats());
  });
  const bots = collections.bots.subscribeChanges((changes) => {
    if (
      changes.some(
        (change) =>
          change.type !== "update" ||
          change.previousValue?.name !== change.value.name
      )
    )
      invalidate(queries.memoryBots());
  });
  signal.addEventListener(
    "abort",
    () => {
      sessions.unsubscribe();
      bots.unsubscribe();
    },
    { once: true }
  );
};
