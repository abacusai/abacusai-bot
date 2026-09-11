/**
 * What a bot's chat shows for an auto-reply turn: the message that came in,
 * and the words that went back out. Not the rules preamble, which is the same
 * paragraph every turn, and not the model's notes around its <reply> tag.
 */
import { describe, expect, it, vi } from "vitest";

import { AgentStatus } from "#shared/agent-types";
import type { MessagingPlatformId } from "#shared/messaging";

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: "ws",
      botId: "bot-1",
    }),
    isPlatformEnabled: (id: MessagingPlatformId) => id === "whatsapp",
    isPlatformConfigured: (id: MessagingPlatformId) => id === "whatsapp",
    approvedUserIds: () => new Set(["U1", "+919804585173"]),
    findPairing: () => null,
    recordPairingRequest: () => {},
    listPairing: () => [],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const harness = () => {
  const shown: Array<{ from: "user" | "agent"; content: string }> = [];
  const prompts: string[] = [];
  const sent: string[] = [];

  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => {
      throw new Error("bot routing must not mint gateway sessions");
    },
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, _s: string, message: string) =>
      prompts.push(message),
    emitUserMessage: (_w: string, _s: string, content: string) =>
      shown.push({ from: "user", content }),
    emitAgentMessage: (_w: string, _s: string, content: string) =>
      shown.push({ from: "agent", content }),
    emitChanged: () => {},
    openBotChat: async () => ({
      botId: "bot-1",
      workspaceId: "ws-bot",
      sessionId: "bot-chat",
    }),
  } as never);

  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    "whatsapp",
    {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async (_chatId: string, text: string) => {
        sent.push(text);
      },
    }
  );

  const internals = gateway as unknown as {
    handleInbound: (
      id: MessagingPlatformId,
      m: Record<string, unknown>
    ) => Promise<void>;
  };

  return {
    gateway,
    shown,
    prompts,
    sent,
    inbound: (text: string) =>
      internals.handleInbound("whatsapp", {
        userId: "U1",
        userName: "Sreemanti 2",
        chatId: "C1",
        text,
      }),
    inboundAs: (userName: string | null, text: string) =>
      internals.handleInbound("whatsapp", {
        userId: "+919804585173",
        userName,
        chatId: "+919804585173",
        text,
      }),
    delta: (content: string) =>
      gateway.handleAgentEvent("bot-chat", {
        type: "event",
        event: { type: "text_delta", content },
      } as never),
    idle: () =>
      gateway.handleAgentEvent("bot-chat", {
        type: "event",
        event: { type: "status_changed", status: AgentStatus.Idle },
      } as never),
  };
};

describe("the bot chat's transcript", () => {
  it("shows the sender's message without the rules the model is sent", async () => {
    const h = harness();

    await h.inbound("Hi");

    expect(h.shown).toEqual([
      { from: "user", content: "[WhatsApp message from Sreemanti 2] Hi" },
    ]);
    // The rules still reach the model, just not the transcript.
    expect(h.prompts[0]).toContain("[auto-reply]");
    expect(h.prompts[0]).toContain("[WhatsApp message from Sreemanti 2] Hi");
  });

  it("shows the delivered words, not the notes the model wrote around them", async () => {
    const h = harness();

    await h.inbound("Hi");
    h.delta(
      "She only said hi, so keep it short.\n<reply>hey! all good?</reply>"
    );
    h.idle();

    expect(h.sent).toEqual(["hey! all good?"]);
    expect(h.shown[1]).toEqual({
      from: "agent",
      content: "[Response from AbacusAI Bot] hey! all good?",
    });
  });

  it("withholds the turn's own text from the transcript while it runs", async () => {
    const h = harness();

    await h.inbound("Hi");
    expect(h.gateway.relayingSession("bot-chat")).toBe(true);

    h.delta("<reply>hey!</reply>");
    h.idle();

    // The turn is over: the user typing in the bot's own chat sees it answer.
    expect(h.gateway.relayingSession("bot-chat")).toBe(false);
  });

  it("sends the answer it already wrote when a follow-up lands mid-turn", async () => {
    const h = harness();

    await h.inbound("Hey tell me abt Nepal flood");
    h.delta("<reply>Over 1,300 dead, rescue ongoing.</reply>");
    // "Hey" arriving behind a real question steers the same turn, and only
    // the last reply of a turn is sent — so the answer used to be dropped and
    // the model would then say "as I said above" about words nobody got.
    await h.inbound("Hey");

    expect(h.sent).toEqual(["Over 1,300 dead, rescue ongoing."]);

    h.delta("<reply>hey! what's up?</reply>");
    h.idle();

    expect(h.sent).toEqual([
      "Over 1,300 dead, rescue ongoing.",
      "hey! what's up?",
    ]);
  });

  it("takes the name once the chat list catches up with the number", async () => {
    const h = harness();

    // Linked seconds ago: WhatsApp has not synced its chat list, so the
    // sweep can only name the sender by their number.
    await h.inboundAs(null, "Hey");
    expect(h.shown[0]?.content).toBe(
      "[WhatsApp message from +919804585173] Hey"
    );

    h.delta("<reply>hey!</reply>");
    h.idle();
    await h.inboundAs("Sreemanti 2", "you there?");

    expect(h.shown.at(-1)?.content).toBe(
      "[WhatsApp message from Sreemanti 2] you there?"
    );
  });

  it("shows what WhatsApp will draw, markdown converted", async () => {
    const h = harness();

    await h.inbound("what is Astra?");
    h.delta("<reply>- **GPT-6 Astra** — OpenAI's newest</reply>");
    h.idle();

    expect(h.sent).toEqual(["• *GPT-6 Astra* — OpenAI's newest"]);
    expect(h.shown[1]?.content).toBe(
      "[Response from AbacusAI Bot] • *GPT-6 Astra* — OpenAI's newest"
    );
  });
});
