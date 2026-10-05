import { contract } from "@abacus-ai/contract/contract";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
/** R3-T5: only each source's specified derived queries are invalidated. */
import { implement } from "@orpc/server";
import { waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { createDb, type Db } from "#renderer/data/db";
import {
  FixtureDb,
  fixtureTransport,
} from "#renderer/data/fixture-db/fixture-db";
import { fixtureBots, fixtureSessions } from "#renderer/data/fixture-db/rows";
import { createMemoryTransport } from "#renderer/data/transport/memory";

import { connectorAsksStore, followBotsSources } from "./live";
import { botsQueries } from "./queries";
const impl = implement(contract);
const source = () => {
  const queue: unknown[] = [];
  let wake: (() => void) | undefined;
  let opened = false;
  return {
    push: (event: unknown) => {
      queue.push(event);
      wake?.();
    },
    isOpen: () => opened,
    stream: async function* ({ signal }: { signal?: AbortSignal }) {
      opened = true;
      signal?.addEventListener("abort", () => wake?.(), { once: true });
      while (!signal?.aborted) {
        if (queue.length) yield queue.shift();
        else
          await new Promise<void>((resolve) => {
            wake = resolve;
          });
      }
    },
  };
};
let db: Db | undefined;
let transport: ReturnType<typeof createMemoryTransport> | undefined;
let controller: AbortController | undefined;
afterEach(async () => {
  controller?.abort();
  transport?.close();
  db?.stop();
  if (db)
    await Promise.all(Object.values(db.collections).map((c) => c.cleanup()));
  connectorAsksStore.setState(() => ({}));
});
it("routes previews, messaging, memory, connector status, sender insert and bot rename precisely", async () => {
  const bots = source(),
    messaging = source(),
    memory = source(),
    connectors = source(),
    attention = source();
  const bot = fixtureBots()[0]!;
  const session = {
    ...fixtureSessions()[0]!,
    owner: {
      kind: "bot" as const,
      botId: bot.id,
      role: "sender" as const,
      key: "sender",
    },
  };
  const pending = {
    requestId: "pending-at-open",
    conversationKey: sessionConversationKey(session.workspaceId, session.id),
    connectorId: "gmail",
    reason: "Mail",
  };
  transport = createMemoryTransport(
    {
      bots: { events: impl.bots.events.handler(bots.stream as never) },
      messaging: {
        events: impl.messaging.events.handler(messaging.stream as never),
      },
      memory: { events: impl.memory.events.handler(memory.stream as never) },
      connectors: {
        events: impl.connectors.events.handler(connectors.stream as never),
        requests: impl.connectors.requests.handler(() => [pending] as never),
      },
      ai: { attention: impl.ai.attention.handler(attention.stream as never) },
    },
    {}
  );
  const feed = new FixtureDb({ bots: [bot], sessions: [session] });
  db = createDb(fixtureTransport(feed));
  await Promise.all([
    db.collections.bots.preload(),
    db.collections.sessions.preload(),
  ]);
  const invalidateQueries = vi.fn(async () => {});
  const onConnectorAsk = vi.fn();
  controller = new AbortController();
  followBotsSources(
    {
      transport,
      queryClient: { invalidateQueries } as never,
      collections: db.collections,
      onConnectorAsk,
    },
    controller.signal
  );
  await waitFor(() => expect(bots.isOpen() && connectors.isOpen()).toBe(true));
  await waitFor(() =>
    expect(connectorAsksStore.state[pending.requestId]).toBe(session.id)
  );
  expect(onConnectorAsk).not.toHaveBeenCalled();
  const q = botsQueries(transport.orpc);
  const expectKeys = async (
    expected: Array<{ queryKey: readonly unknown[] }>
  ) => {
    await waitFor(() =>
      expect(invalidateQueries.mock.calls).toEqual(
        expected.map(({ queryKey }) => [{ queryKey }])
      )
    );
    invalidateQueries.mockClear();
  };
  bots.push({ type: "changed" });
  await expectKeys([q.chatPreviews()]);
  messaging.push({ type: "changed" });
  await expectKeys([q.senderChats(), q.messaging()]);
  memory.push({ type: "changed" });
  await expectKeys([q.memoryBots()]);
  connectors.push({ type: "status-changed" });
  await expectKeys([q.connectorStatuses()]);
  feed.bots.upsert({ ...bot, name: "Renamed" });
  await expectKeys([q.memoryBots()]);
  feed.sessions.upsert({ ...session, id: "new-sender" });
  await expectKeys([q.senderChats()]);
  connectors.push({
    type: "request",
    request: { ...pending, requestId: "live" },
  });
  await waitFor(() =>
    expect(onConnectorAsk).toHaveBeenCalledWith(session.id, "live")
  );
  connectors.push({ type: "cleared", requestId: pending.requestId });
  await waitFor(() =>
    expect(connectorAsksStore.state[pending.requestId]).toBeUndefined()
  );
});
