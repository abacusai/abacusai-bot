/**
 * An auto-reply belongs to the bot that set it up.
 *
 * The report: the user deleted an auto-reply for Ma from Routines, set up a
 * new one in a new bot, and Ma's next message still landed in the old bot's
 * conversation. Delivery was one global pointer — whichever bot turned
 * auto-reply on first — and the new bot's setup approved Ma without ever
 * becoming her bot. The row now names its bot, routing prefers it, and
 * deleting the row deletes the conversations with her too.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

const revoked: string[] = [];
let pairingRow: Record<string, unknown> | null = null;

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
      // The global pointer still names the OLD bot.
      botId: "bot-old",
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
    approvedUserIds: () => new Set(["Ma"]),
    findPairing: () => pairingRow,
    recordPairingRequest: () => {},
    listPairing: () => (pairingRow != null ? [pairingRow] : []),
    revokePairing: (platform: string, userId: string) => {
      revoked.push(`${platform}:${userId}`);
    },
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = () => {
  const openedFor: string[] = [];
  const forgotten: string[] = [];
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      throw new Error("must route to a bot");
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    openBotChat: async (botId: string) => ({
      botId,
      workspaceId: "ws",
      sessionId: `chat-${botId}`,
    }),
    openBotSenderChat: async (botId: string) => {
      openedFor.push(botId);
      return { botId, workspaceId: "ws", sessionId: `chat-${botId}` };
    },
    forgetSenderChats: (platform: string, chatId: string) => {
      forgotten.push(`${platform}:${chatId}`);
    },
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "+919804585173",
    }
  );
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  return { gateway, openedFor, forgotten, internals };
};

describe("which bot answers a sender", () => {
  it("is the bot named on the sender's row, not the global pointer", async () => {
    pairingRow = {
      platform: "whatsapp",
      userId: "Ma",
      userName: "Ma",
      chatId: "Ma",
      status: "approved",
      managedBy: "bot",
      botId: "bot-new",
      firstSeenAt: "2026-09-02T00:00:00Z",
      firstMessage: null,
    };
    const { openedFor, internals } = harness();

    await internals.handleInbound("whatsapp", {
      userId: "Ma",
      userName: "Ma",
      chatId: "Ma",
      text: "Hi",
    });

    expect(openedFor).toEqual(["bot-new"]);
  });

  it("falls back to the global pointer for a row from before rows named a bot", async () => {
    pairingRow = {
      platform: "whatsapp",
      userId: "Ma",
      userName: "Ma",
      chatId: "Ma",
      status: "approved",
      managedBy: "bot",
      firstSeenAt: "2026-09-02T00:00:00Z",
      firstMessage: null,
    };
    const { openedFor, internals } = harness();

    await internals.handleInbound("whatsapp", {
      userId: "Ma",
      userName: "Ma",
      chatId: "Ma",
      text: "Hi",
    });

    expect(openedFor).toEqual(["bot-old"]);
  });
});

describe("deleting an auto-reply", () => {
  it("removes the row and every bot conversation with that sender", async () => {
    pairingRow = {
      platform: "whatsapp",
      userId: "Ma",
      userName: "Ma",
      chatId: "Ma",
      status: "approved",
      managedBy: "bot",
      botId: "bot-new",
      firstSeenAt: "2026-09-02T00:00:00Z",
      firstMessage: null,
    };
    const { gateway, forgotten } = harness();
    revoked.length = 0;

    await gateway.decidePairing({
      platformId: "whatsapp",
      userId: "Ma",
      decision: "revoke",
    });

    expect(revoked).toEqual(["whatsapp:Ma"]);
    expect(forgotten).toEqual(["whatsapp:Ma"]);
  });
});
