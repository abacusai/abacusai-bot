import { AgentStatus } from "@abacus-ai/contract/agent-types";
import type { MessagingPlatformId } from "@abacus-ai/contract/messaging";
/**
 * The self lane: the user typing at their own chat (WhatsApp's
 * message-yourself, a shared Abacus AI bot's DM) is answered by the app's
 * home bot, and ONLY the user. The global respondToInbound
 * switch governs other people, and no bootstrap touches it: the first cut
 * flipped it, and a friend's WhatsApp "hi" got answered as the user the
 * moment a link finished.
 */
import { describe, expect, it, vi } from "vitest";

const settings = {
  gatewayEnabled: true,
  autoApproveTools: true,
  respondToInbound: false,
  workspaceId: "ws" as string | null,
  botId: null as string | null,
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
const { gatewayTurns } = await import("./messaging-turns.test-support");

const harness = (
  withBots = true
): {
  gateway: InstanceType<typeof MessagingGatewayService>;
  prompts: string[];
  /** What reached the WhatsApp chat. */
  sent: string[];
  ensured: number;
  /** A turn the user started in the app is running on the home bot's chat. */
  appTurn: boolean;
  inbound: (userId: string, text: string) => Promise<void>;
  delta: (content: string) => void;
  idle: () => void;
} => {
  const prompts: string[] = [];
  const sent: string[] = [];
  const state = { ensured: 0, appTurn: false };

  const turns = gatewayTurns(() => gateway);
  const gateway = new MessagingGatewayService({
    ...(withBots
      ? {
          homeBots: {
            get: () => "home-bot",
            set: () => {},
            ensure: () => {
              state.ensured += 1;
              return "home-bot";
            },
          },
          openBotChat: async (botId: string) => ({
            botId,
            workspaceId: "ws",
            sessionId: "home-chat",
          }),
        }
      : {}),
    resolveWorkspaceId: () => "ws",
    createAgentSession: () => ({ id: "session-1" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: (_w: string, s: string, message: string) => {
      turns.sent(s);
      prompts.push(message);
    },
    emitUserMessage: () => {},
    emitChanged: () => {},
    isSessionBusy: () => state.appTurn,
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
    gateway,
    prompts,
    sent,
    get ensured() {
      return state.ensured;
    },
    get appTurn() {
      return state.appTurn;
    },
    set appTurn(value: boolean) {
      state.appTurn = value;
    },
    delta: (content: string) =>
      turns.emit("home-chat", { type: "text_delta", content }),
    idle: () =>
      turns.emit("home-chat", {
        type: "status_changed",
        status: AgentStatus.Idle,
      }),
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

    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.prompts).toHaveLength(1);
  });

  it("asks for the home bot on every message, so a deleted one comes back", async () => {
    const h = harness();
    await h.inbound("ME", "hi");

    expect(h.ensured).toBe(1);
  });

  it("treats the owner as the owner: no auto-reply rules on their words", async () => {
    const h = harness();
    await h.inbound("ME", "what's on today?");

    expect(h.prompts[0]).not.toContain("[auto-reply]");
    expect(h.prompts[0]).toContain("what's on today?");
    // The owner hears where the answer lands, and how files reach a phone.
    expect(h.prompts[0]).toContain("on the user's phone]");
    expect(h.prompts[0]).toContain("present_deliverable");
    expect(h.prompts[0]).toContain("localhost");
  });

  it("answers nobody else while the switch is off", async () => {
    settings.respondToInbound = false;

    const h = harness();
    await h.inbound("RAJ", "hi");

    expect(h.prompts).toHaveLength(0);
  });

  it("stays quiet in a build without bots", async () => {
    settings.respondToInbound = false;

    const h = harness(false);
    await h.inbound("ME", "hi");

    expect(h.prompts).toHaveLength(0);
  });

  it("stays quiet while the user has the self chat paused", async () => {
    settings.respondToInbound = false;
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

    const h = harness();
    // Over LOOP_BURST (20) messages inside the window reads as an echo loop.
    for (let i = 0; i < 25; i += 1) await h.inbound("ME", `echo ${i}`);

    // A later message gets nothing; the lane really is holding.
    const before = h.prompts.length;
    await h.inbound("ME", "hi again");
    expect(h.prompts).toHaveLength(before);

    // But the bot and the switch are untouched, so nothing has to be found
    // and re-wired by hand: the pause lapses and the lane answers again.
    expect(settings.respondToInbound).toBe(false);
    expect(settings.autoReplyPausedUntil).toBeGreaterThan(Date.now());

    settings.autoReplyPausedUntil = Date.now() - 1;
    await h.inbound("ME", "still there?");
    expect(h.prompts.length).toBeGreaterThan(before);
  });
});

/**
 * The home bot's chat is one conversation the user reaches two ways, the app
 * and the chat app. A turn's answer goes back where its turn came from.
 */
describe("where a home bot's answer goes", () => {
  it("answers a WhatsApp message on WhatsApp, words meant for the user and all", async () => {
    const h = harness();

    await h.inbound("ME", "remind me what the user guide said");
    // The contact filter would swap this for "let me get back to you on
    // that": the owner is the user, so it goes as written.
    h.delta("The user guide says to restart it first.");
    h.idle();

    expect(h.sent).toEqual(["The user guide says to restart it first."]);
  });

  it("keeps a turn started in the app in the app, the WhatsApp message waiting its turn", async () => {
    const h = harness();
    // Prime the route, then the user types in the app.
    await h.inbound("ME", "hi");
    h.delta("hey!");
    h.idle();
    h.sent.length = 0;
    h.prompts.length = 0;

    h.appTurn = true;
    await h.inbound("ME", "and the weather?");
    // Not steered into the app's turn, which would carry its answer here.
    expect(h.prompts).toEqual([]);

    h.delta("Your three meetings are at 9, 11 and 4.");
    h.appTurn = false;
    h.idle();
    // The app's answer stayed in the app; the waiting message runs now.
    expect(h.sent).toEqual([]);
    expect(h.prompts).toHaveLength(1);
    expect(h.prompts[0]).toContain("and the weather?");

    h.delta("Sunny, 24°C.");
    h.idle();
    expect(h.sent).toEqual(["Sunny, 24°C."]);
  });

  it("keeps the answer in the app once the user joins a WhatsApp turn from there", async () => {
    const h = harness();

    await h.inbound("ME", "summarise my inbox");
    h.delta("Working on it");
    h.gateway.noteAppMessage("home-chat");
    h.delta("Here is your inbox summary and the reminder you asked for.");
    h.idle();

    expect(h.sent).toEqual([]);
  });
});
