/**
 * Hover warming: a stuck hover request cannot hold the click past the
 * session's own ready cap, and a session the runtime already holds is
 * never re-hydrated by a hover.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";

import type { AiClient } from "#renderer/data/ai";

import * as b from "../fixtures/builders";
import { FakeRelay } from "../fixtures/relay";
import { chatLoading } from "./lazy-runtime";
import { createChatRuntime } from "./runtime";

const queryClients: QueryClient[] = [];
afterEach(() => {
  for (const client of queryClients.splice(0)) client.clear();
});

const setup = (hydrate: AiClient["hydrate"]) => {
  const relay = new FakeRelay();
  relay.emitAll(b.sessionReady());
  const ai: AiClient = { ...relay.ai, hydrate: vi.fn(hydrate) };
  const chat = createChatRuntime(ai, { sessionOptions: { readyCapMs: 100 } });
  const queryClient = new QueryClient();
  queryClients.push(queryClient);
  const transport = {
    orpc: {
      ai: {
        hydrate: {
          queryOptions: (options: {
            input: Parameters<AiClient["hydrate"]>[0];
          }) => ({
            ...options,
            queryKey: ["ai.hydrate", options.input],
            queryFn: ({ signal }: { signal: AbortSignal }) =>
              ai.hydrate(options.input, { signal }),
          }),
        },
      },
    },
  } as never;
  return {
    relay,
    ai,
    chat,
    queryClient,
    loading: chatLoading({
      chat,
      prepareChat: async () => {},
      queryClient,
      transport,
    }),
  };
};

it("a click after a hover whose hydrate never answers settles at the session's ready cap", async () => {
  const { relay, chat, loading } = setup(() => new Promise(() => {}));
  loading.warm(relay.threadId);
  const started = Date.now();
  await expect(loading.load(relay.threadId)).rejects.toThrow(
    "hydration timed out"
  );
  expect(Date.now() - started).toBeLessThan(1_000);
  chat.forget(relay.threadId);
});

it("hovering a session the runtime already holds issues no hydrate", async () => {
  const { relay, ai, chat, queryClient, loading } = setup((input, options) =>
    relay.ai.hydrate(input, options)
  );
  await loading.load(relay.threadId);
  expect(ai.hydrate).toHaveBeenCalledTimes(1);
  loading.warm(relay.threadId);
  expect(ai.hydrate).toHaveBeenCalledTimes(1);
  expect(queryClient.getQueryCache().getAll()).toHaveLength(0);
  expect(chat.peek("never-opened")).toBeUndefined();
  chat.forget(relay.threadId);
  await vi.waitFor(() => expect(relay.stats.openIterators).toBe(0));
});
