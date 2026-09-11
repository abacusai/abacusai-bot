/**
 * WHICH bot answers depends on who is talking. The user's own chat routes to
 * the dedicated self bot (the Telegram bootstrap's "AbacusAI Bot <-> You");
 * everyone else routes to the general auto-reply bot. One shared id used to
 * send a WhatsApp group's auto-reply conversations into the user's personal
 * Telegram bot.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: true,
  workspaceId: "ws" as string | null,
  botId: null as string | null,
  selfBotId: null as string | null,
  selfBotIds: {} as Partial<Record<MessagingPlatformId, string>>,
  autoReplyBootstrapped: true,
};

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({ ...settings }),
  saveGatewaySettings: (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
  },
  isPlatformEnabled: (id: MessagingPlatformId) =>
    id === "whatsapp" || id === "abacus_discord",
  isPlatformConfigured: (id: MessagingPlatformId) =>
    id === "whatsapp" || id === "abacus_discord",
  approvedUserIds: () => new Set(["ME", "GROUP"]),
  findPairing: () => null,
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = (): {
  botsOpened: string[];
  gatewaySessions: number;
  inbound: (
    userId: string,
    text: string,
    platform?: MessagingPlatformId
  ) => Promise<void>;
} => {
  const botsOpened: string[] = [];
  const state = { gatewaySessions: 0 };

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      state.gatewaySessions += 1;
      return { id: `session-${state.gatewaySessions}` } as never;
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
    openBotChat: async (botId: string) => {
      botsOpened.push(botId);
      return { botId, workspaceId: "ws-bot", sessionId: `chat-${botId}` };
    },
  } as never);

  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "ME",
    }
  );
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "abacus_discord",
    {
      id: "abacus_discord",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "me",
    }
  );

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  return {
    botsOpened,
    get gatewaySessions() {
      return state.gatewaySessions;
    },
    inbound: (userId: string, text: string, platform = "whatsapp") =>
      internals.handleInbound(platform, {
        userId,
        userName: userId,
        chatId: userId,
        text,
      }),
  };
};

describe("who answers whom", () => {
  it("sends the user's own chat to the self bot, never the general one", async () => {
    settings.selfBotId = "self-bot";
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.botsOpened).toEqual(["self-bot"]);
  });

  it("sends a group to the general bot, never the self bot", async () => {
    settings.selfBotId = "self-bot";
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("GROUP", "Hi @Alex Rivera");

    expect(h.botsOpened).toEqual(["general-bot"]);
  });

  it("keeps a group away from the self bot when no general bot is picked", async () => {
    // The field case: only the bootstrap bot existed, and the group's
    // auto-reply conversations were filed under the user's personal
    // Telegram bot. With no general bot, a group gets a gateway session.
    settings.selfBotId = "self-bot";
    settings.botId = null;

    const h = harness();
    await h.inbound("GROUP", "Hi @Alex Rivera");

    expect(h.botsOpened).toEqual([]);
    expect(h.gatewaySessions).toBe(1);
  });

  it("sends the Abacus AI Discord DM to its own bot, never Telegram's", async () => {
    settings.selfBotId = "self-bot";
    settings.selfBotIds = { abacus_discord: "discord-bot" };
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("me", "hey", "abacus_discord");

    expect(h.botsOpened).toEqual(["discord-bot"]);
  });

  it("never lets the Discord DM fall through to Telegram's bot", async () => {
    // Before the Discord lane has its bot, the DM must not borrow the
    // Telegram one — nor the general bot, which is for other people. It
    // gets a plain gateway session.
    settings.selfBotId = "self-bot";
    settings.selfBotIds = {};
    settings.botId = "general-bot";

    const h = harness();
    await h.inbound("me", "hey", "abacus_discord");

    expect(h.botsOpened).toEqual([]);
    expect(h.gatewaySessions).toBe(1);
  });

  it("still serves the self chat off a legacy botId-only config", async () => {
    settings.selfBotId = null;
    settings.botId = "legacy-bot";

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.botsOpened).toEqual(["legacy-bot"]);
  });
});
