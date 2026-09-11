/**
 * The gateway surface behind the agent's messaging tools, in the default
 * agent-initiated-only mode (respondToInbound off).
 *
 * The contract worth pinning: an incoming message is recorded — into the log
 * read_chat_messages reads, and into the contact list, auto-approved — and
 * nothing else happens: no session, no turn, no reply. Sends are user-driven
 * from a desktop chat, go to whoever the user names, are logged, and fail
 * loudly (a platform that is not running, a delivery error) so the model can
 * read the error rather than a silent drop.
 */
import { describe, expect, it, vi } from "vitest";

const recordPairingRequest = vi.fn();
const approvePairing = vi.fn();

vi.mock("./messaging-config-service", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("./messaging-config-service")>();
  return {
    ...actual,
    // The gateway's message log persists to disk now; unstubbed, every test
    // read the previous tests' entries (and the suite wrote into the real
    // ~/.abacusai-bot) — the source of three cross-contaminated failures.
    readStoredMessageLog: () => [],
    writeStoredMessageLog: () => {},
    readGatewaySettings: () => ({
      gatewayEnabled: true,
      autoApproveTools: true,
      respondToInbound: false,
      workspaceId: null,
    }),
    recordPairingRequest,
    approvePairing,
    listPairing: () => [
      {
        platform: "telegram",
        userId: "U1",
        userName: "Ada",
        chatId: "chat-1",
        status: "approved",
        firstSeenAt: "2026-01-01T00:00:00Z",
        firstMessage: "hi",
      },
    ],
  };
});

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const gatewayWith = (
  connector: { sendText: (chatId: string, text: string) => Promise<void> },
  platform = "telegram"
): InstanceType<typeof MessagingGatewayService> => {
  const gateway = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({ id: "s" }) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({ success: true }) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
    platform,
    { id: platform, start: async () => {}, stop: async () => {}, ...connector }
  );
  return gateway;
};

const inbound = (
  gateway: InstanceType<typeof MessagingGatewayService>,
  platform: string,
  overrides: Record<string, unknown> = {}
): Promise<void> =>
  (
    gateway as unknown as {
      handleInbound: (p: string, m: unknown) => Promise<void>;
    }
  ).handleInbound(platform, {
    userId: "U7",
    userName: "Grace",
    chatId: "chat-7",
    text: "are you around?",
    ...overrides,
  });

describe("agent-initiated sends", () => {
  it("delivers to whoever the user names, and logs what went out", async () => {
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith({
      sendText: async (chatId, text) => {
        sent.push([chatId, text]);
      },
    });

    // A known chat and a never-seen numeric id both deliver: the user asking
    // in a desktop chat is the authorization, not a pairing row.
    await gateway.sendToChat("telegram", "chat-1", "on my way");
    await gateway.sendToChat("telegram", "999888", "hello");

    expect(sent).toEqual([
      ["chat-1", "on my way"],
      ["999888", "hello"],
    ]);
    expect(
      (await gateway.readMessages()).map((row) => [row.direction, row.text])
    ).toEqual([
      ["out", "on my way"],
      ["out", "hello"],
    ]);
  });

  it("refuses a platform that is not running, naming the fix", async () => {
    const gateway = gatewayWith({ sendText: async () => {} }, "telegram");

    await expect(gateway.sendToChat("discord", "c", "hello")).rejects.toThrow(
      /not connected/i
    );
  });

  it("propagates a delivery failure instead of swallowing it", async () => {
    const gateway = gatewayWith({
      sendText: async () => {
        throw new Error("chat not found");
      },
    });

    await expect(
      gateway.sendToChat("telegram", "chat-1", "hello")
    ).rejects.toThrow("chat not found");
    // A failed send is not traffic; it must not appear as one.
    expect(await gateway.readMessages()).toEqual([]);
  });
});

describe("inbound with listening off", () => {
  it("records the message and the contact, and starts nothing", async () => {
    recordPairingRequest.mockClear();
    approvePairing.mockClear();
    let sessions = 0;
    const gateway = new MessagingGatewayService({
      resolveWorkspaceId: () => "ws",
      createAgentSession: () => {
        sessions += 1;
        return { id: "s" } as never;
      },
      updateSessionLabel: () => {},
      startSession: async () => ({ success: true }) as never,
      sendMessage: () => {},
      emitUserMessage: () => {},
      emitChanged: () => {},
    } as never);
    const sent: string[] = [];
    (gateway as unknown as { connectors: Map<string, unknown> }).connectors.set(
      "whatsapp",
      {
        id: "whatsapp",
        start: async () => {},
        stop: async () => {},
        sendText: async (_c: string, text: string) => {
          sent.push(text);
        },
      }
    );

    await inbound(gateway, "whatsapp");

    // Readable on request…
    expect(await gateway.readMessages({ platform: "whatsapp" })).toMatchObject([
      { direction: "in", userName: "Grace", text: "are you around?" },
    ]);
    // …remembered as a contact, approved rather than queued…
    expect(recordPairingRequest).toHaveBeenCalledTimes(1);
    expect(approvePairing).toHaveBeenCalledWith("whatsapp", "U7");
    // …and otherwise inert: no session, no turn, no reply as the user.
    expect(sessions).toBe(0);
    expect(sent).toEqual([]);
  });

  it("filters reads by chat and honours the limit", async () => {
    const gateway = gatewayWith({ sendText: async () => {} });

    for (let i = 0; i < 5; i += 1) {
      await inbound(gateway, "telegram", { text: `msg-${i}` });
      await inbound(gateway, "telegram", {
        chatId: "other",
        text: `noise-${i}`,
      });
    }

    const rows = await gateway.readMessages({ chatId: "chat-7", limit: 2 });
    expect(rows.map((row) => row.text)).toEqual(["msg-3", "msg-4"]);
  });

  it("reads a chat live when the connector can open it, over the log", async () => {
    // A connector that drives a real client answers "check X's messages" from
    // the actual chat, not the passive log — which for a chat nothing arrived
    // in while running would otherwise be empty.
    const gateway = gatewayWith({
      sendText: async () => {},
      readChat: async (chatId: string, limit: number) =>
        [
          {
            userName: "Raj",
            text: "on my way",
            direction: "in" as const,
            at: "2026-08-26T10:00:00Z",
          },
          {
            userName: null,
            text: "great",
            direction: "out" as const,
            at: "2026-08-26T10:01:00Z",
          },
        ].slice(0, limit),
    } as never);

    const rows = await gateway.readMessages({
      platform: "telegram",
      chatId: "7179209985",
      limit: 30,
    });
    expect(rows.map((r) => [r.direction, r.text, r.userName])).toEqual([
      ["in", "on my way", "Raj"],
      ["out", "great", null],
    ]);
  });

  it("reads live even when the call omits the platform", async () => {
    // The agent usually has only a chat id; with no platform named, the gateway
    // tries each running connector that can read live and takes the first hit.
    const gateway = gatewayWith({
      sendText: async () => {},
      readChat: async () => [
        {
          userName: "Raj",
          text: "hi",
          direction: "in" as const,
          at: "2026-08-26T10:00:00Z",
        },
      ],
    } as never);

    const rows = await gateway.readMessages({
      chatId: "7179209985",
      limit: 30,
    });
    expect(rows.map((r) => [r.platform, r.text])).toEqual([["telegram", "hi"]]);
  });
});

describe("sending by name", () => {
  const contactsConnector = (
    sent: Array<[string, string]>
  ): {
    sendText: (chatId: string, text: string) => Promise<void>;
    listContacts: () => Array<{ chatId: string; name: string }>;
  } => ({
    sendText: async (chatId, text) => {
      sent.push([chatId, text]);
    },
    listContacts: () => [
      { chatId: "14155551234@s.whatsapp.net", name: "Mom" },
      { chatId: "14155559999@s.whatsapp.net", name: "Ravi Kumar" },
      { chatId: "14155558888@s.whatsapp.net", name: "Ravi Verma" },
    ],
  });

  it("resolves a unique contact name to its chat id", async () => {
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith(contactsConnector(sent), "whatsapp");

    await gateway.sendToChat("whatsapp", "Mom", "on my way");
    // Case-insensitive, and a unique substring is enough.
    await gateway.sendToChat("whatsapp", "kumar", "hi");

    expect(sent).toEqual([
      ["14155551234@s.whatsapp.net", "on my way"],
      ["14155559999@s.whatsapp.net", "hi"],
    ]);
  });

  it("resolves names from the pairing store on token platforms too", async () => {
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith({
      sendText: async (chatId: string, text: string) => {
        sent.push([chatId, text]);
      },
    });

    await gateway.sendToChat("telegram", "Ada", "hello");

    expect(sent).toEqual([["chat-1", "hello"]]);
  });

  it("refuses an ambiguous name, listing the candidates", async () => {
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith(contactsConnector(sent), "whatsapp");

    await expect(gateway.sendToChat("whatsapp", "Ravi", "hi")).rejects.toThrow(
      /more than one contact.*Ravi Kumar.*Ravi Verma/s
    );
    expect(sent).toEqual([]);
  });

  it("passes an unknown name through to the connector", async () => {
    // The connector is the arbiter: each fails honestly on a genuine miss,
    // while a gateway refusal turned "not in the rendered sidebar" into
    // "does not exist".
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith(contactsConnector(sent), "whatsapp");

    await gateway.sendToChat("whatsapp", "Taco Bell", "hi");

    expect(sent).toEqual([["Taco Bell", "hi"]]);
  });

  it("still passes ids and phone numbers straight through", async () => {
    const sent: Array<[string, string]> = [];
    const gateway = gatewayWith(contactsConnector(sent), "whatsapp");

    await gateway.sendToChat("whatsapp", "+49 151 1234567", "hi");
    await gateway.sendToChat("whatsapp", "77777@s.whatsapp.net", "hi");

    expect(sent.map(([chatId]) => chatId)).toEqual([
      "+49 151 1234567",
      "77777@s.whatsapp.net",
    ]);
  });

  it("filters list_chats by query, merging the address book in", () => {
    const gateway = gatewayWith(contactsConnector([]), "whatsapp");

    expect(gateway.listKnownChats("mom")).toEqual([
      {
        platform: "whatsapp",
        chatId: "14155551234@s.whatsapp.net",
        name: "Mom",
        status: "approved",
      },
    ]);
    // Unfiltered: pairing rows and contacts together.
    expect(gateway.listKnownChats()).toHaveLength(4);
  });
});

describe("the chat list", () => {
  it("lists the known contacts with a usable name", () => {
    const gateway = gatewayWith({ sendText: async () => {} });

    expect(gateway.listKnownChats()).toEqual([
      {
        platform: "telegram",
        chatId: "chat-1",
        name: "Ada",
        status: "approved",
      },
    ]);
  });

  it("reports which platforms are running", () => {
    const gateway = gatewayWith({ sendText: async () => {} }, "whatsapp");

    expect(gateway.runningPlatforms()).toEqual(["whatsapp"]);
  });
});

/**
 * "me" as a recipient.
 *
 * The user's own account is the one address no address book holds — connecting
 * is what establishes it — so asking them for it is asking about the phone
 * they just paired. Resolved here rather than in the tool: it is the platform
 * that knows.
 */
describe("sending to yourself", () => {
  const withSelf = (self: string | null) => {
    const sent: Array<{ to: string; text: string }> = [];
    const service = new MessagingGatewayService({
      resolveWorkspaceId: () => null,
      createAgentSession: () => ({}) as never,
      updateSessionLabel: () => {},
      startSession: async () => ({}) as never,
      sendMessage: () => {},
      emitUserMessage: () => {},
      emitChanged: () => {},
    } as never);
    (service as any).connectors.set("whatsapp", {
      id: "whatsapp",
      start: async () => {},
      stop: async () => {},
      sendText: async (to: string, text: string) => {
        sent.push({ to, text });
      },
      selfChatId: () => self,
    });
    return { service, sent };
  };

  it("resolves to the account the platform is connected as", async () => {
    const { service, sent } = withSelf("919804585173@s.whatsapp.net");

    await service.sendToChat("whatsapp", "me", "hi");
    await service.sendToChat("whatsapp", "myself", "again");

    expect(sent.map((row) => row.to)).toEqual([
      "919804585173@s.whatsapp.net",
      "919804585173@s.whatsapp.net",
    ]);
  });

  /**
   * Not silently treated as a contact named "me": that would either miss and
   * read as an unknown name, or — worse — match somebody actually called Me.
   */
  it("says the platform has not said yet, rather than guessing", async () => {
    const { service, sent } = withSelf(null);

    await expect(service.sendToChat("whatsapp", "me", "hi")).rejects.toThrow(
      "has not said which account"
    );
    expect(sent).toHaveLength(0);
  });
});
