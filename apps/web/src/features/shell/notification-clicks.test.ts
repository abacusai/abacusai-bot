import type { NotificationMetadata } from "@abacus-ai/contract/contract";
import { expect, it } from "vitest";

import { notificationHref } from "./notification-clicks";

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
])("routes notification metadata %j", (metadata, href) => {
  expect(notificationHref(metadata)).toBe(href);
});
