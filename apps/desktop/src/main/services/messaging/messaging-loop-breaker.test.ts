/**
 * The backstop under the echo guards.
 *
 * A group's chat-list preview names its speaker, so the bot read its own
 * replies back as incoming messages and answered them — then answered those.
 * Three rounds of commentary meant for the user went to a real group before
 * anyone stopped it.
 *
 * The preview fix closes that particular hole. This closes the shape of it: no
 * text-matching guard can be trusted never to miss again, so something has to
 * notice that a chat is producing turns faster than a person could and stop
 * answering, whatever the reason turns out to be.
 */
import { describe, expect, it, vi } from "vitest";

const saveGatewaySettings = vi.fn();

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: true,
      workspaceId: null,
    }),
    saveGatewaySettings,
    recordPairingRequest: vi.fn(),
    approvePairing: vi.fn(),
    listPairing: () => [
      {
        platform: "whatsapp",
        userId: "Girlies",
        userName: "Girlies",
        chatId: "Girlies",
        status: "approved",
        firstSeenAt: "2026-01-01T00:00:00Z",
        firstMessage: "hi",
      },
    ],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const gateway = (): {
  inbound: (chatId: string) => boolean;
} => {
  const service = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);

  const internals = service as unknown as {
    tooFastToBeReal: (platform: string, chatId: string) => boolean;
  };

  return { inbound: (chatId) => internals.tooFastToBeReal("whatsapp", chatId) };
};

describe("a chat producing turns faster than a person could", () => {
  it("is left alone at a pace a real group can reach", () => {
    const { inbound } = gateway();

    // The routing tests already treat ten in a burst as an ordinary thing for
    // a person to do. Tripping at anything near that would silence real
    // conversations to catch a rare one.
    for (let i = 0; i < 20; i++) expect(inbound("Girlies")).toBe(false);
  });

  it("trips once the pace stops being human", () => {
    const { inbound } = gateway();

    // A loop has no ceiling — it runs as fast as the agent answers — so it
    // passes any threshold within a minute or two.
    for (let i = 0; i < 20; i++) inbound("Girlies");

    expect(inbound("Girlies")).toBe(true);
  });

  it("counts each chat on its own", () => {
    // One loop must not silence every other conversation with it.
    const { inbound } = gateway();

    for (let i = 0; i < 21; i++) inbound("Girlies");

    expect(inbound("Baba")).toBe(false);
  });

  it("forgets a burst once its window has passed", () => {
    // Yesterday's busy hour is not today's loop.
    const { inbound } = gateway();
    const realNow = Date.now;
    let clock = realNow();
    Date.now = () => clock;

    try {
      for (let i = 0; i < 21; i++) inbound("Girlies");
      clock += 61_000;

      expect(inbound("Girlies")).toBe(false);
    } finally {
      Date.now = realNow;
    }
  });
});
