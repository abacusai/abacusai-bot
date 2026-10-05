/**
 * A replaced socket refetches the query families a lost notice would have
 * refreshed, not the whole cache, and a flapping link coalesces them.
 */
import { QueryClient } from "@tanstack/react-query";
import { afterEach, expect, it } from "vitest";

import type { TransportState } from "#renderer/data/transport/lifecycle";

import { followReconnects } from "./recovery";

const link = () => {
  let state: TransportState = "connecting";
  let generation = 0;
  const listeners = new Set<() => void>();
  return {
    get state() {
      return state;
    },
    get generation() {
      return generation;
    },
    onChange(listener: () => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    open() {
      state = "open";
      generation += 1;
      for (const listener of Array.from(listeners)) listener();
    },
    drop() {
      state = "reconnecting";
      for (const listener of Array.from(listeners)) listener();
    },
  };
};

const clients: QueryClient[] = [];
afterEach(() => {
  for (const client of clients.splice(0)) client.clear();
});

const seeded = () => {
  const client = new QueryClient();
  clients.push(client);
  for (const path of [
    ["settings", "get"],
    ["account", "state"],
    ["models", "list"],
    ["git", "diff"],
    ["files", "treeRoot"],
  ])
    client.setQueryData([path, { type: "query", input: {} }], "cached");
  const invalidated = () =>
    client
      .getQueryCache()
      .getAll()
      .filter((query) => query.state.isInvalidated)
      .map((query) => (query.queryKey[0] as string[]).join("."))
      .sort();
  return { client, invalidated };
};

it("leaves the first socket alone, then invalidates only the missed-notice families", async () => {
  const transport = link();
  const { client, invalidated } = seeded();
  followReconnects(transport, client);
  transport.open();
  await Promise.resolve();
  expect(invalidated()).toEqual([]);
  transport.drop();
  transport.open();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(invalidated()).toEqual([
    "account.state",
    "files.treeRoot",
    "models.list",
    "settings.get",
  ]);
});

it("coalesces a flapping link into one more pass", async () => {
  const transport = link();
  const { client } = seeded();
  let passes = 0;
  const invalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = (async (
    ...args: Parameters<typeof invalidate>
  ) => {
    passes += 1;
    await new Promise((resolve) => setTimeout(resolve, 20));
    return invalidate(...args);
  }) as typeof client.invalidateQueries;
  followReconnects(transport, client);
  transport.open();
  for (let i = 0; i < 5; i += 1) {
    transport.drop();
    transport.open();
  }
  await new Promise((resolve) => setTimeout(resolve, 100));
  expect(passes).toBe(2);
});
