import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { expect, it } from "vitest";

import type { Draft } from "#renderer/lib/continuity/composer-drafts";
import { createHarness } from "#renderer/test-support/app-harness";

import {
  noticeDraft,
  notificationOptions,
  placeNoticeDraft,
  withOwner,
} from "./notification-clicks";

it.each<[NotificationMetadata, string | null]>([
  [{ kind: "session", sessionId: "s" }, "/sessions/s"],
  [{ sessionId: "legacy" }, "/sessions/legacy"],
  [{ kind: "bot", botId: "b", sessionId: "s" }, "/bots/b/chats/s"],
  [{ kind: "bot", botId: "b" }, "/bots/b"],
  [{ kind: "routine", routineId: "r", sessionId: "s" }, "/routines/r?run=s"],
  [{ kind: "messaging" }, "/library/messaging"],
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

it.each<[unknown, string | null]>([
  ["Add a high-score board", "Add a high-score board"],
  ["  line one\nline two\u0007  ", "line one line two"],
  ["\u0000\u001b", null],
  [42, null],
  ["x".repeat(600), "x".repeat(500)],
])("reads a notice's draft as plain capped text: %j", (text, expected) => {
  expect(noticeDraft(text)).toBe(expected);
});

it("puts a notice's draft in an empty composer only, never over the user's words", () => {
  const drafts: Record<string, Draft> = {
    empty: { text: "", attachments: [] },
    typed: { text: "my own words", attachments: [] },
  };
  const place = (id: string, update: (draft: Draft) => Draft) => {
    drafts[id] = update(drafts[id] ?? { text: "", attachments: [] });
  };
  placeNoticeDraft({ sessionId: "empty", draft: "Add a board" }, place);
  placeNoticeDraft({ sessionId: "typed", draft: "Add a board" }, place);
  placeNoticeDraft({ draft: "No session" }, place);
  placeNoticeDraft({ sessionId: "none" }, place);
  expect(drafts).toEqual({
    empty: { text: "Add a board", attachments: [] },
    typed: { text: "my own words", attachments: [] },
  });
});
