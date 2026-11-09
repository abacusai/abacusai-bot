/**
 * "Me" is any path to the user's own chat that is up, not one lane. With the
 * shared Telegram bot down and personal Telegram connected, a message to the
 * user used to fail and read to the model as "reconnecting"; it now goes to
 * Saved Messages, then another app's own chat (labelled), and with nothing up
 * it waits in the outbox and goes once, by whichever path comes back first.
 */
import type {
  MessagingPlatformId,
  MessagingPlatformState,
} from "@abacus-ai/contract/messaging";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const stored = vi.hoisted(() => ({
  outbox: null as { pending: unknown[]; done: string[] } | null,
  approved: new Set<string>(),
}));

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
  readStoredOutbox: () => stored.outbox,
  writeStoredOutbox: (state: { pending: unknown[]; done: string[] }) => {
    stored.outbox = structuredClone(state);
  },
  readStoredSeen: () => null,
  writeStoredSeen: () => {},
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: null,
    autoReplyPausedUntil: 0,
  }),
  isPlatformEnabled: () => false,
  isPlatformConfigured: () => false,
  approvedUserIds: () => stored.approved,
  approvePairing: (_platform: string, userId: string) =>
    stored.approved.add(userId),
  findPairing: () => null,
  recordPairingRequest: () => {},
  listPairing: () => [],
}));
vi.mock("./page-boot-watch", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./page-boot-watch")>()),
  watchLaneHints: () => () => {},
  userActive: () => false,
}));
vi.mock("@abacus-ai/agent/user-language", () => ({
  readUserLanguage: () => null,
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Gateway = InstanceType<typeof MessagingGatewayService>;

/** A lane: its sends, and whether it is up. */
const lanes = () => {
  const sent: Array<[MessagingPlatformId, string, string]> = [];
  const failing = new Set<MessagingPlatformId>();
  const gateway: Gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  const internals = gateway as unknown as {
    connectors: Map<string, unknown>;
    setState: (id: string, state: MessagingPlatformState) => void;
    handleInbound: (id: string, message: unknown) => Promise<void>;
  };
  const add = (
    id: MessagingPlatformId,
    self: { selfChatId?: string; ownChatForSend?: string }
  ): void => {
    internals.connectors.set(id, {
      id,
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId: string, text: string) => {
        if (failing.has(id)) throw new Error(`${id} is down`);
        sent.push([id, chatId, text]);
      },
      ...(self.selfChatId != null
        ? { selfChatId: () => self.selfChatId! }
        : {}),
      ...(self.ownChatForSend != null
        ? { ownChatForSend: () => self.ownChatForSend! }
        : {}),
    });
    internals.setState(id, "connected");
  };
  return {
    gateway,
    sent,
    add,
    down: (id: MessagingPlatformId) => internals.setState(id, "error"),
    up: (id: MessagingPlatformId) => internals.setState(id, "connected"),
    inbound: (id: MessagingPlatformId, userId: string) =>
      internals.handleInbound(id, {
        userId,
        userName: "Sam",
        chatId: userId,
        text: "hello",
      }),
  };
};

beforeEach(() => {
  stored.outbox = null;
  stored.approved = new Set();
});
afterEach(() => {
  vi.useRealTimers();
});

describe("a message to the user's own chat", () => {
  it("takes the shared bot first, then Saved Messages, then another app's own chat, labelled", async () => {
    const h = lanes();
    h.add("abacus_telegram", { selfChatId: "bot-dm" });
    h.add("telegram", { ownChatForSend: "saved-1" });
    h.add("whatsapp", { selfChatId: "wa-self" });

    await h.gateway.sendToChat("telegram", "me", "one");
    h.down("abacus_telegram");
    const second = await h.gateway.sendToChat("abacus_telegram", "me", "two");
    h.down("telegram");
    const third = await h.gateway.sendToChat("telegram", "me", "three");

    expect(h.sent.map(([id, chat]) => `${id}:${chat}`)).toEqual([
      "abacus_telegram:bot-dm",
      "telegram:saved-1",
      "whatsapp:wa-self",
    ]);
    expect(second).toMatchObject({ platform: "telegram", queued: false });
    expect(third).toMatchObject({ platform: "whatsapp", downApp: "telegram" });
    // The other app's chat says which app could not carry it.
    expect(h.sent[2]?.[2]).toMatch(/^Telegram .+\n\nthree$/);
  });

  it("never treats Saved Messages as the owner talking", async () => {
    const h = lanes();
    h.add("telegram", { ownChatForSend: "saved-1" });

    await h.inbound("telegram", "saved-1");

    // Not approved on sight as "me", and nothing answered it.
    expect(stored.approved.has("saved-1")).toBe(false);
    expect(h.sent).toEqual([]);
  });

  it("waits with nothing up, then goes exactly once by the first path back", async () => {
    vi.useFakeTimers();
    const h = lanes();
    h.add("abacus_telegram", { selfChatId: "bot-dm" });
    h.add("whatsapp", { selfChatId: "wa-self" });
    h.down("abacus_telegram");
    h.down("whatsapp");

    const result = await h.gateway.sendToChat("telegram", "me", "check-in");
    expect(result).toMatchObject({ queued: true });
    // Nothing up: waiting is not a try, so hours pass without giving up.
    await vi.advanceTimersByTimeAsync(3 * 60 * 60_000);
    expect(h.sent).toEqual([]);
    expect(stored.outbox?.pending).toHaveLength(1);

    h.up("whatsapp");
    await vi.advanceTimersByTimeAsync(10);
    h.up("abacus_telegram");
    await vi.advanceTimersByTimeAsync(60 * 60_000);

    // The first app back carries it, labelled; the second one back sends nothing.
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.[0]).toBe("whatsapp");
    expect(h.sent[0]?.[2]).toMatch(/check-in$/);
    expect(stored.outbox?.pending).toEqual([]);
  });

  it("is kept, not lost, when the path that was up fails the send", async () => {
    vi.useFakeTimers();
    const h = lanes();
    h.add("abacus_telegram", { selfChatId: "bot-dm" });
    const internals = h.gateway as unknown as {
      connectors: Map<string, { sendText: unknown }>;
    };
    let fail = true;
    const real = internals.connectors.get("abacus_telegram")!;
    const send = real.sendText as (c: string, t: string) => Promise<void>;
    real.sendText = async (chatId: string, text: string) => {
      if (fail) throw new Error("aborted");
      await send(chatId, text);
    };

    expect(await h.gateway.sendToChat("telegram", "me", "hi")).toMatchObject({
      queued: true,
    });
    fail = false;
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(h.sent).toEqual([["abacus_telegram", "bot-dm", "hi"]]);
  });
});
