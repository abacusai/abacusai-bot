import { AgentMode } from "@abacus-ai/contract/agent-types";
import type { IpcEvent } from "@abacus-ai/contract/contracts";
import { sessionConversationKey } from "@abacus-ai/contract/conversation-scope";
/**
 * The browser and device permission prompt belongs to one conversation.
 *
 * It used to carry no conversation at all: the first prompt in an app-wide
 * queue was shown to whoever was looking, and any pane could grant it. Now
 * every prompt names the conversation whose turn is waiting, only that
 * conversation can list or answer it, and a caller with no conversation is
 * denied rather than shown to a stranger.
 */
import { describe, expect, it } from "vitest";

import { BuiltinToolPermissions } from "./builtin-tool-permissions";

const here = sessionConversationKey("ws-1", "session-1");
const elsewhere = sessionConversationKey("ws-1", "session-2");

const gate = (): { gate: BuiltinToolPermissions; events: IpcEvent[] } => {
  const events: IpcEvent[] = [];
  const state: Record<string, unknown> = { builtinDevicesApproval: "ask" };
  return {
    events,
    gate: new BuiltinToolPermissions({
      mcpConfigService: {
        readState: () => state,
        writeState: () => undefined,
      } as never,
      emitEvent: (event) => events.push(event),
      getSessionMode: () => AgentMode.Normal,
      setBrowserApprovalAlways: async () => undefined,
      conversationKeyForSession: (sessionId) =>
        sessionId === "session-1"
          ? here
          : sessionId === "session-2"
            ? elsewhere
            : null,
    }),
  };
};

const emitted = (events: IpcEvent[]) => {
  const event = events.find(
    (entry) => entry.type === "browser-permission-request"
  );
  if (event?.type !== "browser-permission-request") throw new Error("no ask");
  return event.request;
};

describe("a permission prompt's conversation", () => {
  it("names the conversation whose turn is waiting", () => {
    const { gate: permissions, events } = gate();

    void permissions.request("device", "tap", "Tap Home", "session-1");

    expect(emitted(events).conversationKey).toBe(here);
  });

  it("lists a prompt only to its own conversation", () => {
    const { gate: permissions } = gate();
    void permissions.request("device", "tap", "Tap Home", "session-1");

    expect(permissions.listPending(here)).toHaveLength(1);
    expect(permissions.listPending(elsewhere)).toHaveLength(0);
  });

  it("lists every conversation's prompts when no conversation is named", () => {
    const { gate: permissions } = gate();
    void permissions.request("device", "tap", "Tap Home", "session-1");
    void permissions.request("device", "swipe", "Swipe", "session-2");

    expect(
      permissions.listPending().map((request) => request.conversationKey)
    ).toEqual([here, elsewhere]);
  });

  it("refuses an answer from another conversation", async () => {
    const { gate: permissions, events } = gate();
    let decided: string | null = null;
    void permissions
      .request("device", "tap", "Tap Home", "session-1")
      .then((decision) => {
        decided = decision;
      });

    await permissions.respond({
      requestId: emitted(events).requestId,
      conversationKey: elsewhere,
      decision: "allow",
    });
    await Promise.resolve();

    expect(decided).toBeNull();
    expect(permissions.listPending(here)).toHaveLength(1);
  });

  it("takes the answer from the conversation that was asked", async () => {
    const { gate: permissions, events } = gate();
    const pending = permissions.request(
      "device",
      "tap",
      "Tap Home",
      "session-1"
    );

    await permissions.respond({
      requestId: emitted(events).requestId,
      conversationKey: here,
      decision: "deny",
    });

    expect(await pending).toBe("deny");
  });

  it("denies a caller with no conversation instead of asking a stranger", async () => {
    const { gate: permissions, events } = gate();

    expect(await permissions.request("device", "tap", "Tap Home")).toBe("deny");
    expect(
      await permissions.request("device", "tap", "Tap Home", "ghost")
    ).toBe("deny");
    expect(
      events.some((event) => event.type === "browser-permission-request")
    ).toBe(false);
  });
});

describe("a connected site's ask (may this chat use your sign-in?)", () => {
  it("asks even when browsing never asks, and passes the user's exact choice on", async () => {
    const { gate: g, events } = gate();
    const pending = g.askSite(
      "goindigo.in",
      "Writer wants to use your sign-in on goindigo.in.",
      "session-1"
    );
    const request = emitted(events);
    expect(request).toMatchObject({
      site: "goindigo.in",
      conversationKey: here,
      tool: "browser_site",
    });
    await g.respond({
      requestId: request.requestId,
      conversationKey: here,
      decision: "always",
    });
    await expect(pending).resolves.toBe("always");
  });

  it("asks a bot running where nothing asks (the default for bots)", async () => {
    const events: IpcEvent[] = [];
    const yolo = new BuiltinToolPermissions({
      mcpConfigService: {
        readState: () => ({}),
        writeState: () => undefined,
      } as never,
      emitEvent: (event) => events.push(event),
      getSessionMode: () => AgentMode.Yolo,
      setBrowserApprovalAlways: async () => undefined,
      conversationKeyForSession: () => here,
    });
    const pending = yolo.askSite("goindigo.in", "s", "session-1", 50);
    expect(emitted(events).site).toBe("goindigo.in");
    await expect(pending).resolves.toBe("deny");
  });

  it("is a no when nobody answers in time, or there is nobody to ask", async () => {
    const { gate: g, events } = gate();
    await expect(g.askSite("goindigo.in", "s", "session-1", 20)).resolves.toBe(
      "deny"
    );
    expect(events.some((e) => e.type === "browser-permission-cleared")).toBe(
      true
    );
    await expect(g.askSite("goindigo.in", "s", "nobody")).resolves.toBe("deny");
  });

  it("is not answered by a browsing setting turned to never ask", async () => {
    const { gate: g, events } = gate();
    const pending = g.askSite("goindigo.in", "s", "session-1", 50);
    emitted(events);
    g.flushPending("allow", "browser");
    await expect(pending).resolves.toBe("deny");
  });
});
