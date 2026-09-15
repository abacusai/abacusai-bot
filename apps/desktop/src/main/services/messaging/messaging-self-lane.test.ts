/**
 * The self lane: the user typing at their own chat (WhatsApp's
 * message-yourself, a shared Abacus AI bot's DM) is answered whenever the
 * auto-reply bot exists — and ONLY the user. The global respondToInbound
 * switch governs other people, and no bootstrap touches it: the first cut
 * flipped it, and a friend's WhatsApp "hi" got answered as the user the
 * moment a link finished.
 */
import { describe, expect, it, vi } from "vitest";

import type { MessagingPlatformId } from "#shared/messaging";

const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: false,
  workspaceId: "ws" as string | null,
  botId: "bot-1" as string | null,
  autoReplyBootstrapped: true,
  autoReplyPausedUntil: 0,
};

/** The pairing row for the self sender, as the pane's pause toggle sets it. */
const pairing = { status: "approved" as "approved" | "paused" };

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readGatewaySettings: () => ({ ...settings }),
  saveGatewaySettings: (patch: Partial<typeof settings>) => {
    Object.assign(settings, patch);
  },
  isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
  isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
  approvedUserIds: () =>
    pairing.status === "approved" ? new Set<string>(["ME"]) : new Set<string>(),
  findPairing: () => ({ status: pairing.status }),
  recordPairingRequest: () => {},
  approvePairing: () => {},
  listPairing: () => [],
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = (): {
  prompts: string[];
  inbound: (userId: string, text: string) => Promise<void>;
} => {
  const prompts: string[] = [];

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: "session-1" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, _s: string, message: string) =>
      prompts.push(message),
    emitUserMessage: () => {},
    emitChanged: () => {},
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

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  return {
    prompts,
    inbound: (userId: string, text: string) =>
      internals.handleInbound("whatsapp", {
        userId,
        userName: userId,
        chatId: userId,
        text,
      }),
  };
};

describe("the self lane", () => {
  it("answers the user's own chat with the global switch off", async () => {
    settings.respondToInbound = false;
    settings.botId = "bot-1";

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.prompts).toHaveLength(1);
  });

  it("answers nobody else while the switch is off", async () => {
    settings.respondToInbound = false;
    settings.botId = "bot-1";

    const h = harness();
    await h.inbound("RAJ", "hi");

    expect(h.prompts).toHaveLength(0);
  });

  it("stays quiet when no auto-reply bot exists", async () => {
    settings.respondToInbound = false;
    settings.botId = null;

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.prompts).toHaveLength(0);
  });

  it("stays quiet while the user has the self chat paused", async () => {
    settings.respondToInbound = false;
    settings.botId = "bot-1";
    pairing.status = "paused";

    const h = harness();
    await h.inbound("ME", "you there?");

    // Approving "me" on sight used to undo the pause with the next message,
    // which left deleting the bot as the only way to stop it answering.
    expect(h.prompts).toHaveLength(0);

    pairing.status = "approved";
    await h.inbound("ME", "ok go on");
    expect(h.prompts).toHaveLength(1);
  });

  it("holds off, keeping its bot, when the loop breaker trips", async () => {
    settings.respondToInbound = false;
    settings.botId = "bot-1";

    const h = harness();
    // Over LOOP_BURST (20) messages inside the window reads as an echo loop.
    for (let i = 0; i < 25; i += 1) await h.inbound("ME", `echo ${i}`);

    // A later message gets nothing — the lane really is holding.
    const before = h.prompts.length;
    await h.inbound("ME", "hi again");
    expect(h.prompts).toHaveLength(before);

    // But the bot and the switch are untouched, so nothing has to be found
    // and re-wired by hand: the pause lapses and the lane answers again.
    expect(settings.botId).toBe("bot-1");
    expect(settings.autoReplyPausedUntil).toBeGreaterThan(Date.now());

    settings.autoReplyPausedUntil = Date.now() - 1;
    await h.inbound("ME", "still there?");
    expect(h.prompts.length).toBeGreaterThan(before);
  });
});
