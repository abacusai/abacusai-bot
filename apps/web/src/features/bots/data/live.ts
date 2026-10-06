import {
  conversationRefFromKey,
  type ConversationKey,
} from "@abacus-ai/contract/conversation-scope";
import type { QueryClient } from "@tanstack/react-query";
import { useSyncExternalStore } from "react";

/**
 * The bots area's live state (spec 03 §6.1): main's per-thread asks and the
 * pending connector asks, read from the document's `ai.attention` and keyless
 * `connectors.events` snapshots; the asks that notify as they arrive; and the
 * collection changes that also feed derived queries (a new sender session, a
 * bot rename), and what `bots.events`, `messaging.events`, `memory.events`
 * and connector status changes make stale (R3-T5).
 */
import type { Collections } from "#renderer/data/db";
import { followNotice, noticeSnapshot } from "#renderer/data/queries/notices";
import type { Transport } from "#renderer/data/transport";

import type { ThreadAttention } from "./attention";
import { botsQueries } from "./queries";

/** Main's asks per thread. */
export const usePermissions = (
  transport: Transport
): Record<string, ThreadAttention> => {
  const attention = noticeSnapshot("attention", transport);
  const snapshot = useSyncExternalStore(attention.subscribe, attention.get);
  return Object.fromEntries(
    (snapshot?.items ?? []).map((item) => [
      item.threadId,
      {
        count: item.questions + item.approvals,
        firstTitle: item.firstTitle,
        oldestAt: item.oldestAt,
      },
    ])
  );
};

const sessionOfKey = (key: ConversationKey): string | null => {
  const ref = conversationRefFromKey(key);
  return ref?.kind === "session" ? ref.sessionId : null;
};

/** Pending connector asks per session (drafts ignored). */
export const useConnectorAsks = (
  transport: Transport
): Record<string, number> => {
  const asks = noticeSnapshot("connectors", transport);
  const snapshot = useSyncExternalStore(asks.subscribe, asks.get);
  const out: Record<string, number> = {};
  for (const request of snapshot?.requests ?? []) {
    const sessionId = sessionOfKey(request.conversationKey);
    if (sessionId != null) out[sessionId] = (out[sessionId] ?? 0) + 1;
  }
  return out;
};

/**
 * Until `signal` aborts: `onConnectorAsk` per new ask in a session, and the
 * derived queries the notices and the collections feed (R3-T5).
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

  followNotice(
    "connectors",
    transport,
    (event) => {
      if (event.type === "status-changed")
        invalidate(queries.connectorStatuses());
      if (event.type !== "request") return;
      const sessionId = sessionOfKey(event.request.conversationKey);
      if (sessionId != null)
        deps.onConnectorAsk?.(sessionId, event.request.requestId);
    },
    signal
  );
  followNotice(
    "bots",
    transport,
    () => invalidate(queries.chatPreviews()),
    signal
  );
  followNotice(
    "messaging",
    transport,
    () => {
      invalidate(queries.senderChats());
      invalidate(queries.messaging());
    },
    signal
  );
  followNotice(
    "memory",
    transport,
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
