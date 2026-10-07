import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { expect, it } from "vitest";

import { createHarness } from "#renderer/test-support/app-harness";

import { notificationOptions, withOwner } from "./notification-clicks";

it.each<[NotificationMetadata, string | null]>([
  [{ kind: "session", sessionId: "s" }, "/sessions/s"],
  [{ sessionId: "legacy" }, "/sessions/legacy"],
  [{ kind: "bot", botId: "b", sessionId: "s" }, "/bots/b/chats/s"],
  [{ kind: "bot", botId: "b" }, "/bots/b"],
  [{ kind: "routine", routineId: "r", sessionId: "s" }, "/routines/r?run=s"],
  [{ kind: "routine", sessionId: "s" }, null],
  [{ kind: "bot", sessionId: "s" }, null],
  [{}, null],
  [
    { kind: "routine", routineId: "a/b", sessionId: "s&x" },
    "/routines/a%2Fb?run=s%26x",
  ],
])("routes notification metadata %j", async (metadata, href) => {
  const app = await createHarness("/bots/new");
  try {
    const options = notificationOptions(metadata);
    expect(options ? app.router.buildLocation(options).href : null).toBe(href);
  } finally {
    await app.cleanup();
  }
});

const owners: Record<string, unknown> = {
  forever: { kind: "bot", botId: "b", role: "forever", key: "forever" },
  sender: { kind: "bot", botId: "b", role: "sender", key: "k" },
  routine: { kind: "bot", botId: "b", role: "routine", key: "r" },
};
const db = {
  collections: {
    sessions: {
      get: (id: string) =>
        id === "plain"
          ? { owner: null }
          : id in owners
            ? { owner: owners[id] }
            : undefined,
    },
  },
} as never;

it.each<[NotificationMetadata, string | null]>([
  // A bot's forever chat is the bot's page: the chats route has none.
  [{ sessionId: "forever" }, "/bots/b"],
  [{ sessionId: "sender" }, "/bots/b/chats/sender"],
  [{ sessionId: "routine" }, "/bots/b/chats/routine"],
  [{ sessionId: "plain" }, "/sessions/plain"],
  [{ sessionId: "unknown" }, "/sessions/unknown"],
  // A kind already set is kept.
  [{ kind: "session", sessionId: "forever" }, "/sessions/forever"],
  [{ kind: "bot", botId: "x", sessionId: "sender" }, "/bots/x/chats/sender"],
])("opens a kind-less notice %j in its owner", async (metadata, href) => {
  const app = await createHarness("/bots/new");
  try {
    const options = notificationOptions(withOwner(metadata, db));
    expect(options ? app.router.buildLocation(options).href : null).toBe(href);
  } finally {
    await app.cleanup();
  }
});
