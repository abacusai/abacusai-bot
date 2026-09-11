import { describe, expect, it } from "vitest";

import { sidebarConversationRoute } from "./sidebar-conversation-route";

describe("sidebar conversation routes", () => {
  it.each([
    ["/bots/bot-1", { kind: "bot", id: "bot-1" }],
    ["/bots/bot-1/edit", { kind: "bot", id: "bot-1" }],
    ["/sessions/session-1", { kind: "session", id: "session-1" }],
    ["/sessions/a%20session", { kind: "session", id: "a session" }],
  ] as const)("selects %s", (pathname, expected) => {
    expect(sidebarConversationRoute(pathname)).toEqual(expected);
  });

  it.each([
    "/",
    "/bots/new",
    "/sessions/new",
    "/settings/connectors",
    "/channels/channel-1",
  ])("does not keep a conversation selected on %s", (pathname) => {
    expect(sidebarConversationRoute(pathname)).toBeNull();
  });
});
