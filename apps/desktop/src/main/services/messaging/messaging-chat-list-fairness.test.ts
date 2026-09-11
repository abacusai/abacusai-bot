/**
 * A synced WhatsApp address book must not push a small platform's chats out
 * of list_chats.
 *
 * The report: Discord connected with two DMs, and the model told the user
 * "I don't see any contacts on Discord" — one flat cap of a hundred, and
 * WhatsApp had filled every row.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("./messaging-config-service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./messaging-config-service")>()),
  readStoredMessageLog: () => [],
  writeStoredMessageLog: () => {},
  readGatewaySettings: () => ({
    gatewayEnabled: true,
    autoApproveTools: true,
    respondToInbound: false,
    workspaceId: null,
  }),
  listPairing: () => [],
}));

const { MessagingGatewayService } = await import("./messaging-gateway-service");

const gateway = () => {
  const service = new MessagingGatewayService({
    resolveWorkspaceId: () => null,
    createAgentSession: () => ({}) as never,
    updateSessionLabel: () => {},
    startSession: async () => ({}) as never,
    sendMessage: () => {},
    emitUserMessage: () => {},
    emitChanged: () => {},
  } as never);
  const connectors = (
    service as unknown as { connectors: Map<string, unknown> }
  ).connectors;
  connectors.set("whatsapp", {
    id: "whatsapp",
    start: async () => {},
    stop: async () => {},
    sendText: async () => {},
    listContacts: () =>
      Array.from({ length: 300 }, (_, i) => ({
        chatId: `Contact ${i}`,
        name: `Contact ${i}`,
      })),
  });
  connectors.set("discord", {
    id: "discord",
    start: async () => {},
    stop: async () => {},
    sendText: async () => {},
    listContacts: () => [
      { chatId: "1234567890", name: "anewja" },
      { chatId: "1234567891", name: "raj" },
    ],
  });
  return service;
};

describe("the chat list under a big address book", () => {
  it("keeps every small platform's rows and counts what it hid", () => {
    const { rows, hidden } = gateway().listKnownChatsDetailed();

    expect(rows.filter((row) => row.platform === "discord")).toHaveLength(2);
    expect(rows.length).toBeLessThanOrEqual(100);
    expect(hidden.whatsapp).toBeGreaterThan(0);
    expect(hidden.discord).toBeUndefined();
  });

  it("lists one platform in full when scoped", () => {
    const { rows, hidden } = gateway().listKnownChatsDetailed(
      undefined,
      "discord"
    );
    expect(rows.map((row) => row.name)).toEqual(["anewja", "raj"]);
    expect(hidden).toEqual({});
  });

  it("returns everything in order when under the cap", () => {
    const service = gateway();
    const rows = service.listKnownChats("anewja");
    expect(rows).toEqual([
      {
        platform: "discord",
        chatId: "1234567890",
        name: "anewja",
        status: "approved",
      },
    ]);
  });
});

describe("a query that names a contact exactly", () => {
  it("lists that contact alone, as a send would resolve it", () => {
    const service = gateway();
    (service as unknown as { connectors: Map<string, unknown> }).connectors.set(
      "discord",
      {
        id: "discord",
        start: async () => {},
        stop: async () => {},
        sendText: async () => {},
        listContacts: () => [
          { chatId: "1543961963875405924", name: "A" },
          { chatId: "1543961963875405925", name: "Rajaniraiyn" },
        ],
      }
    );
    const rows = service.listKnownChats("A", "discord");
    expect(rows.map((row) => row.name)).toEqual(["A"]);
    // No exact match: the substring search still finds people.
    expect(
      service.listKnownChats("raj", "discord").map((row) => row.name)
    ).toEqual(["Rajaniraiyn"]);
  });
});
