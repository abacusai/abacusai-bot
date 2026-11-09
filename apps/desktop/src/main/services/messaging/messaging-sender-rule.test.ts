/**
 * Who auto-reply answers: the user's own chat and who the user approved,
 * nobody else. Being off used to approve every sender it saw, and the approved
 * list is exactly who gets answered once it is on, so switching on answered
 * strangers, groups and channels as the user. Real store, real gateway.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { InboundMessage } from "./connector";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "sender-rule-"));
vi.mock("../../paths", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../paths")>()),
  abacusBotHome: () => home,
}));

const store = await import("./messaging-config-service");
const { MessagingGatewayService } = await import("./messaging-gateway-service");

const reset = (): void => {
  for (const name of fs.readdirSync(home))
    fs.rmSync(path.join(home, name), { recursive: true, force: true });
};
beforeEach(reset);
afterEach(reset);

/** Notices word themselves asynchronously; setImmediate is never faked here. */
const settle = async (): Promise<void> => {
  for (let i = 0; i < 10; i += 1)
    await new Promise((resolve) => setImmediate(resolve));
};

const harness = () => {
  const answered: string[] = [];
  const notices: Array<{ title: string; body: string }> = [];
  let clock = 1_000_000;
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: `s-${answered.length}` }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: (_ws: string, _s: string, text: string) => {
      answered.push(text);
    },
    emitChanged: () => {},
    notifyUser: (_p: MessagingPlatformId, title: string, body: string) => {
      notices.push({ title, body });
    },
    now: () => clock,
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "own-chat",
    }
  );
  const inbound = async (
    message: Partial<InboundMessage> & { userId: string }
  ): Promise<void> => {
    await (
      gateway as unknown as {
        handleInbound(p: MessagingPlatformId, m: InboundMessage): Promise<void>;
      }
    ).handleInbound("whatsapp", {
      userName: message.userId,
      chatId: message.userId,
      text: `hello from ${message.userId}`,
      ...message,
    });
    await settle();
  };
  return {
    gateway,
    inbound,
    answered,
    notices,
    advance: (ms: number) => {
      clock += ms;
    },
    answeredBy: (userId: string) =>
      answered.some((text) => text.includes(`hello from ${userId}`)),
  };
};

const row = (userId: string) =>
  store.listPairing().find((entry) => entry.userId === userId);

describe("auto-reply off", () => {
  it("approves nobody: a person, a group and a channel all wait", async () => {
    const h = harness();
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.inbound({ userId: "Deals group", kind: "group" });
    await h.inbound({ userId: "News channel" });

    for (const id of ["Grace", "Deals group", "News channel"])
      expect(row(id)?.status).toBe("pending");
    expect(h.answered).toEqual([]);
    // Off, nothing waits on the user: the chat app already notified them.
    expect(h.notices).toEqual([]);
  });

  it("switching on afterwards answers none of them", async () => {
    const h = harness();
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.inbound({ userId: "Deals group", kind: "group" });
    h.gateway.enableAutoReply("bot-1");
    h.advance(120_000);
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.inbound({ userId: "Deals group", kind: "group" });

    expect(h.answered).toEqual([]);
    expect(h.gateway.autoReplyStatus().approved).toEqual([]);
  });
});

describe("auto-reply on", () => {
  it("answers a person the user approved, and only them", async () => {
    const h = harness();
    store.saveGatewaySettings({ respondToInbound: true });
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.gateway.decidePairing({
      platformId: "whatsapp",
      userId: "Grace",
      decision: "approve",
    });
    await h.inbound({
      userId: "Grace",
      kind: "direct",
      text: "hello from Grace",
    });
    await h.inbound({ userId: "Stranger", kind: "direct" });

    expect(h.answeredBy("Grace")).toBe(true);
    expect(h.answeredBy("Stranger")).toBe(false);
    expect(row("Stranger")?.status).toBe("pending");
  });

  it("tells the user once per chat, and folds a burst into one notice when the gap ends", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const h = harness();
      store.saveGatewaySettings({ respondToInbound: true });
      await h.inbound({ userId: "Ana", kind: "direct" });
      await h.inbound({ userId: "Ana", kind: "direct" });
      await h.inbound({ userId: "Ben", kind: "direct" });
      await h.inbound({ userId: "Cy", kind: "direct" });
      await h.inbound({ userId: "Deals", kind: "group" });
      await h.inbound({ userId: "Promos", kind: "group" });
      expect(h.notices.map((n) => n.title)).toEqual([
        "Ana messaged you on WhatsApp",
      ]);

      // No further message needed: the folded notice goes when the gap ends.
      h.advance(60_000);
      vi.advanceTimersByTime(60_000);
      await settle();
      expect(h.notices).toHaveLength(2);
      expect(h.notices[1]).toEqual({
        title: "4 chats are waiting for you",
        body: "Ben, Cy, 2 groups. Not answered until you approve them in Messaging.",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("tells the user about someone who first wrote while it was off, when they write again", async () => {
    const h = harness();
    await h.inbound({ userId: "Grace", kind: "direct" });
    expect(h.notices).toEqual([]);

    h.gateway.enableAutoReply("bot-1");
    await h.inbound({ userId: "Grace", kind: "direct" });
    h.advance(120_000);
    await h.inbound({ userId: "Grace", kind: "direct" });

    expect(h.notices.map((n) => n.title)).toEqual([
      "Grace messaged you on WhatsApp",
    ]);
    expect(row("Grace")?.toldAt).toBeDefined();
  });

  it("tells the user about a new group, by the group's name", async () => {
    const h = harness();
    store.saveGatewaySettings({ respondToInbound: true });
    await h.inbound({
      userId: "Crypto deals",
      userName: "Lee",
      chatName: "Crypto deals",
      kind: "group",
    });

    expect(h.answeredBy("Crypto deals")).toBe(false);
    expect(h.notices[0]!.title).toBe(
      "The group Crypto deals posted on WhatsApp"
    );
    expect(h.notices[0]!.body).toContain("everyone in it reads the replies");
    // Listed by the group, not by whoever posted first.
    expect(row("Crypto deals")?.userName).toBe("Crypto deals");
  });

  it("with the private-chats switch, answers anyone one to one but never a group", async () => {
    const h = harness();
    store.saveGatewaySettings({
      respondToInbound: true,
      answerPrivateChats: true,
    });
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.inbound({ userId: "Deals group", kind: "group" });
    // A chat the platform could not classify is not taken for one person.
    await h.inbound({ userId: "Unknown chat" });

    expect(h.answeredBy("Grace")).toBe(true);
    expect(h.answeredBy("Deals group")).toBe(false);
    expect(h.answeredBy("Unknown chat")).toBe(false);
    // Answering is not approving: switching it off leaves nobody approved.
    expect(row("Grace")).toBeUndefined();
    // The lists agree with the gate: the group and the unknown chat wait.
    expect(h.gateway.getSnapshot().pending.map((r) => r.userId)).toEqual([
      "Deals group",
      "Unknown chat",
    ]);
  });

  it("answers a group the user approved by name", async () => {
    const h = harness();
    store.saveGatewaySettings({ respondToInbound: true });
    h.gateway.allowSender(
      {
        platform: "whatsapp",
        userId: "Work group",
        chatId: "Work group",
        name: "Work group",
      },
      "bot-1"
    );
    await h.inbound({ userId: "Work group", kind: "group" });

    expect(h.answeredBy("Work group")).toBe(true);
  });

  it("still answers the user's own chat", async () => {
    const h = harness();
    store.saveGatewaySettings({ respondToInbound: true });
    await h.inbound({
      userId: "own-chat",
      text: "hello from own-chat",
    });

    expect(h.answeredBy("own-chat")).toBe(true);
  });
});

describe("taking back what the old rule approved (config v2)", () => {
  /** messaging.json as an older version left it: everyone seen while off, approved. */
  const oldConfig = (respondToInbound: boolean): void => {
    const approved = (userId: string, extra: object = {}) => ({
      platform: "whatsapp",
      userId,
      userName: userId,
      chatId: userId,
      status: "approved",
      firstSeenAt: "2026-10-01T00:00:00Z",
      firstMessage: "hi",
      ...extra,
    });
    fs.writeFileSync(
      path.join(home, "messaging.json"),
      JSON.stringify({
        respondToInbound,
        pairing: [
          approved("Grace"),
          approved("Deals group"),
          // The one the user asked a bot to answer.
          approved("Mom", { managedBy: "bot", botId: "bot-1" }),
          // The shared lane's own chat.
          approved("me", { platform: "abacus_telegram" }),
        ],
      })
    );
  };

  it("with auto-reply off, sends every unasked approval back to waiting", () => {
    oldConfig(false);

    expect(row("Grace")).toMatchObject({ status: "pending", autoAdded: true });
    expect(row("Deals group")).toMatchObject({
      status: "pending",
      autoAdded: true,
    });
    expect(row("Mom")?.status).toBe("approved");
    // The user's own chat is never someone to approve.
    expect(row("me")).toMatchObject({ status: "approved" });
    expect(row("me")?.autoAdded).toBeUndefined();
  });

  it("with auto-reply on, answers none of the old approvals until the user approves each again", async () => {
    oldConfig(true);
    const h = harness();
    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

    // The user's own chat is answered, but not listed as someone approved.
    expect(names(h.gateway.autoReplyStatus().approved)).toEqual(["Mom"]);
    expect(names(h.gateway.autoReplyStatus().reapprove)).toEqual([
      "Grace",
      "Deals group",
    ]);

    // Even a chat known to be one person: nobody is added unless the user adds them.
    await h.inbound({ userId: "Grace", kind: "direct" });
    await h.inbound({ userId: "Deals group", kind: "group" });

    expect(h.answeredBy("Grace")).toBe(false);
    expect(h.answeredBy("Deals group")).toBe(false);
    expect(names(h.gateway.autoReplyStatus().approved)).toEqual(["Mom"]);
    expect(h.gateway.getSnapshot().pending.map((r) => r.userId)).toEqual([
      "Grace",
      "Deals group",
    ]);
    // Each was being answered and stops: the user hears it (the second folds
    // into the next notice).
    expect(h.notices.map((n) => n.title)).toEqual([
      "Grace on WhatsApp is no longer answered",
    ]);
    // Approving again is the user's decision, and it sticks.
    await h.gateway.decidePairing({
      platformId: "whatsapp",
      userId: "Grace",
      decision: "approve",
    });
    expect(row("Grace")?.autoAdded).toBeUndefined();
    await h.inbound({ userId: "Grace", kind: "direct" });
    expect(h.answeredBy("Grace")).toBe(true);
  });

  it("with auto-reply on, says a chat is no longer answered even if it was told about before", async () => {
    oldConfig(true);
    // An earlier notice already marked Grace as told.
    store.recordPairingRequest({
      platform: "whatsapp",
      userId: "Grace",
      userName: "Grace",
      chatId: "Grace",
      firstMessage: null,
    });
    store.markPairingTold("whatsapp", "Grace");
    const h = harness();

    await h.inbound({ userId: "Grace", kind: "direct" });

    expect(h.answeredBy("Grace")).toBe(false);
    expect(h.notices.map((n) => n.title)).toEqual([
      "Grace on WhatsApp is no longer answered",
    ]);
  });

  it("with auto-reply on, takes back a chat nobody can say is one person", async () => {
    oldConfig(true);
    const h = harness();

    // A group DM the platform cannot classify, approved by the old rule.
    await h.inbound({ userId: "Grace" });

    expect(h.answeredBy("Grace")).toBe(false);
    expect(row("Grace")?.status).toBe("pending");
  });

  it("runs once, and its rows outlast a flood of new strangers", () => {
    oldConfig(false);
    store.approvePairing("whatsapp", "Grace");
    expect(row("Grace")?.status).toBe("approved");

    for (let i = 0; i < 80; i += 1)
      store.recordPairingRequest({
        platform: "whatsapp",
        userId: `spam-${i}`,
        userName: null,
        chatId: `spam-${i}`,
        firstMessage: null,
      });
    expect(row("Grace")?.status).toBe("approved");
    expect(row("Deals group")?.status).toBe("pending");
  });
});

describe("the auto_reply tool's view", () => {
  it("lists exactly who is answered, groups marked", () => {
    const h = harness();
    store.recordPairingRequest({
      platform: "whatsapp",
      userId: "Work group",
      userName: "Work group",
      chatId: "Work group",
      firstMessage: null,
      kind: "group",
    });
    store.approvePairing("whatsapp", "Work group");

    expect(h.gateway.autoReplyStatus().approved).toEqual([
      {
        platform: "whatsapp",
        userId: "Work group",
        name: "Work group",
        isGroup: true,
      },
    ]);
  });
});
