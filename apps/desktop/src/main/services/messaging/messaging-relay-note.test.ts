/**
 * relayNote: a bot's answer to a request the user made from their own chat
 * on an app (WhatsApp's message-yourself) goes back to that chat. The note
 * runs as a hidden turn on the chat's route, so the bot's reply is sent
 * there; it waits behind a running turn, is never shown as the user's words,
 * and never goes to a contact's chat.
 */
import {
  AgentStatus,
  type UserTextTags,
} from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: true,
    workspaceId: "ws",
    botId: "home-bot",
    autoReplyBootstrapped: true,
    autoReplyPausedUntil: 0,
  }),
  saveGatewaySettings: () => {},
  isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
  approvedUserIds: () => new Set<string>(["ME", "RAJ"]),
  findPairing: () => ({ status: "approved" }),
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");
const { gatewayTurns } = await import("./messaging-turns.test-support");

const NOTE = "[bot answer] Writer answered your request q7.";

const harness = () => {
  const prompts: Array<{ message: string; userText?: UserTextTags }> = [];
  const shown: string[] = [];
  const sent: Array<{ chatId: string; text: string }> = [];
  const turns = gatewayTurns(() => gateway);
  const gateway = new MessagingGatewayService({
    homeBots: {
      get: () => "home-bot",
      set: () => {},
      ensure: () => "home-bot",
    },
    openBotChat: async (botId: string) => ({
      botId,
      workspaceId: "ws",
      sessionId: "home-chat",
    }),
    openBotSenderChat: async (
      botId: string,
      _platform: string,
      chatId: string
    ) => ({ botId, workspaceId: "ws", sessionId: `sender-${chatId}` }),
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: "session-1" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (
      _w: string,
      s: string,
      message: string,
      userText?: UserTextTags
    ) => {
      turns.sent(s);
      prompts.push({ message, ...(userText != null ? { userText } : {}) });
    },
    emitUserMessage: (_w: string, _s: string, text: string) => {
      shown.push(text);
    },
    emitChanged: () => {},
    isSessionBusy: () => false,
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async (chatId: string, text: string) => {
        sent.push({ chatId, text });
      },
      selfChatId: () => "ME",
    }
  );
  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };
  const session = (chat: string) =>
    chat === "ME" ? "home-chat" : `sender-${chat}`;
  return {
    gateway,
    prompts,
    shown,
    sent,
    inbound: (chat: string, text: string) =>
      internals.handleInbound("whatsapp", {
        userId: chat,
        userName: chat,
        chatId: chat,
        text,
      }),
    reply: (chat: string, words: string) => {
      turns.emit(session(chat), { type: "text_delta", content: words });
      turns.emit(session(chat), {
        type: "status_changed",
        status: AgentStatus.Idle,
      });
    },
  };
};

const ME = { platform: "whatsapp", chatId: "ME" };

describe("relayNote", () => {
  it("runs the note as a hidden turn in the user's own chat and sends the reply there", async () => {
    const h = harness();
    await h.inbound("ME", "ask Writer for a draft");
    h.reply("ME", "Asked Writer, I'll pass it on.");

    expect(h.gateway.relayNote("home-chat", ME, NOTE)).toBe(true);
    const last = h.prompts.at(-1)!;
    expect(last.message).toBe(NOTE);
    expect(last.userText).toEqual({
      systemReminder: true,
      operator: { kind: "environment-notice" },
    });
    // Never echoed as something the user said.
    expect(h.shown).not.toContain(NOTE);

    h.reply("ME", "Writer's draft: memory matters.");
    // Sent after the first reply's send settles.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.sent.at(-1)).toEqual({
      chatId: "ME",
      text: expect.stringContaining("Writer's draft"),
    });
  });

  it("waits behind a running turn, then runs", async () => {
    const h = harness();
    await h.inbound("ME", "ask Writer for a draft");
    h.reply("ME", "Asked Writer.");
    await h.inbound("ME", "what's on today?");
    const before = h.prompts.length;

    expect(h.gateway.relayNote("home-chat", ME, NOTE)).toBe(true);
    expect(h.prompts).toHaveLength(before);

    h.reply("ME", "Two meetings.");
    expect(h.prompts.at(-1)?.message).toBe(NOTE);
  });

  it("never goes to a contact's chat", async () => {
    const h = harness();
    await h.inbound("RAJ", "hi");
    h.reply("RAJ", "<reply>Hello</reply>");
    expect(
      h.gateway.relayNote(
        "sender-RAJ",
        { platform: "whatsapp", chatId: "RAJ" },
        NOTE
      )
    ).toBe(false);
  });

  it("says false when the chat has no route here, so the app's chat gets it", () => {
    expect(harness().gateway.relayNote("home-chat", ME, NOTE)).toBe(false);
  });

  it("says false for a route bound to another session", async () => {
    const h = harness();
    await h.inbound("ME", "hi");
    expect(h.gateway.relayNote("someone-else", ME, NOTE)).toBe(false);
  });
});
