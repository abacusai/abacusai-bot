/**
 * A send to "me" that lands while the platform is still starting waits for
 * it, rather than failing on "has not said which account it is connected as".
 *
 * The report: a new WhatsApp bot's first mission (say hi to the user) fired
 * seconds after launch. WhatsApp Web was still booting; the tool answered
 * that it could not identify the user's own chat, and the model asked the
 * user to message it first.
 */
import { describe, expect, it, vi } from "vitest";

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
      respondToInbound: false,
      workspaceId: null,
    }),
    listPairing: () => [],
    isPlatformEnabled: (id: string) => id === "whatsapp",
    isPlatformConfigured: (id: string) => id === "whatsapp",
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

type Gateway = InstanceType<typeof MessagingGatewayService>;

const changes: number[] = [];

const gatewayWith = (connector: {
  selfChatId: () => string | null;
  sendText: (chatId: string, text: string) => Promise<void>;
}): Gateway => {
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({ id: "s" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {
      changes.push(Date.now());
    },
  } as never);
  const internals = gateway as unknown as {
    connectors: Map<string, unknown>;
    states: Map<string, { state: string; error: string | null }>;
  };
  internals.connectors.set("whatsapp", {
    id: "whatsapp",
    start: async () => {},
    stop: async () => {},
    ...connector,
  });
  internals.states.set("whatsapp", { state: "connected", error: null });
  return gateway;
};

describe("a platform that is linked but has not yet learned who the user is", () => {
  it("is reported as starting until it does", () => {
    let self: string | null = null;
    const gateway = gatewayWith({
      selfChatId: () => self,
      sendText: async () => {},
    });
    expect(gateway.startingPlatforms()).toEqual(["whatsapp"]);
    self = "+919804585173";
    expect(gateway.startingPlatforms()).toEqual([]);
  });

  it('makes a send to "me" wait for it instead of failing', async () => {
    let self: string | null = null;
    const sent: string[] = [];
    const gateway = gatewayWith({
      selfChatId: () => self,
      sendText: async (chatId) => {
        sent.push(chatId);
      },
    });
    // The account becomes known a moment later: the bridge attached.
    setTimeout(() => {
      self = "+919804585173";
    }, 700);

    await gateway.sendToChat("whatsapp", "me", "hi");

    expect(sent).toEqual(["+919804585173"]);
  });

  it("gives up waiting after the bound, with the honest error", async () => {
    const gateway = gatewayWith({
      selfChatId: () => null,
      sendText: async () => {},
    });
    // The bound itself, short: still pending when it runs out.
    const started = Date.now();
    await gateway.awaitReady("whatsapp", 600);
    expect(Date.now() - started).toBeGreaterThanOrEqual(550);
    expect(gateway.startingPlatforms()).toEqual(["whatsapp"]);
    // Past the bound the send says what is actually wrong, not "sent".
    (gateway as unknown as { awaitReady: () => Promise<void> }).awaitReady =
      async () => {};
    await expect(gateway.sendToChat("whatsapp", "me", "hi")).rejects.toThrow(
      /has not said which account/
    );
  });
});

describe("what the card says while it syncs", () => {
  const whatsapp = (gateway: Gateway): string | undefined =>
    gateway.getSnapshot().platforms.find((row) => row.id === "whatsapp")?.state;

  it('wears "syncing", not "connected", until the account is known', () => {
    let self: string | null = null;
    const gateway = gatewayWith({
      selfChatId: () => self,
      sendText: async () => {},
    });
    expect(whatsapp(gateway)).toBe("syncing");
    self = "+919804585173";
    expect(whatsapp(gateway)).toBe("connected");
  });

  it("re-announces the snapshot the moment syncing ends", async () => {
    vi.useFakeTimers();
    try {
      let self: string | null = null;
      const gateway = gatewayWith({
        selfChatId: () => self,
        sendText: async () => {},
      });
      const before = changes.length;
      // The connector reports connected: the watch starts.
      (
        gateway as unknown as {
          setState: (id: string, state: string) => void;
        }
      ).setState("whatsapp", "connecting");
      (
        gateway as unknown as {
          setState: (id: string, state: string) => void;
        }
      ).setState("whatsapp", "connected");
      const afterConnect = changes.length;
      await vi.advanceTimersByTimeAsync(6_000);
      // Nothing to announce while still syncing.
      expect(changes.length).toBe(afterConnect);
      self = "+919804585173";
      await vi.advanceTimersByTimeAsync(2_500);
      expect(changes.length).toBe(afterConnect + 1);
      expect(changes.length).toBeGreaterThan(before);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a platform whose chat list has not been read yet", () => {
  it("counts as starting until the connector says the list is in", () => {
    let ready = false;
    const gateway = gatewayWith({
      selfChatId: () => "+919804585173",
      sendText: async () => {},
    });
    (
      gateway as unknown as { connectors: Map<string, Record<string, unknown>> }
    ).connectors.set("whatsapp", {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async () => {},
      selfChatId: () => "+919804585173",
      contactsReady: () => ready,
    });
    expect(gateway.startingPlatforms()).toEqual(["whatsapp"]);
    ready = true;
    expect(gateway.startingPlatforms()).toEqual([]);
  });
});
