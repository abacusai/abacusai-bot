/**
 * The own chat of an account whose chats WhatsApp files under lids.
 *
 * A user's WhatsApp listed every chat, the "Message yourself" one included,
 * under a lid, while the connector knew the account only by its phone jid.
 * The own chat was never found (logged on every chat-list read), it was
 * listed to the model as a stranger, and its messages waited on a page
 * round trip to be told apart from the user's other outgoing ones.
 */
import { describe, expect, it, vi } from "vitest";

import type { BridgeChat } from "./whatsapp-bridge";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { isPackaged: false },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

const PHONE_JID = "15550000001@c.us";
const OWN_LID = "88001234567890@lid";

type Internals = {
  loggedIn: boolean;
  bridge: unknown;
  bridgeReady: boolean;
  selfJid: string | null;
  self: string | null;
  selfDisplayName: string | null;
  findSelf: () => Promise<void>;
  isOwnChat: (jid: string) => boolean;
};

const chat = (jid: string, name: string): BridgeChat => ({
  jid,
  name,
  isGroup: false,
  // WhatsApp's own flag is not set on a lid-filed self chat.
  isMe: false,
  unreadCount: 0,
});

const CHATS: BridgeChat[] = [
  chat("70000000000001@lid", "Ana"),
  chat(OWN_LID, "Me (phone)"),
  chat("70000000000002@lid", "Ben"),
];

const harness = (lids: Array<string | null>) => {
  const logs: string[] = [];
  let asked = 0;
  const bridge = {
    ensure: async () => true,
    myId: async () => ({
      jid: PHONE_JID,
      digits: "15550000001",
      lid: lids[Math.min(asked++, lids.length - 1)] ?? null,
    }),
    listChats: async () => CHATS,
  };
  const connector = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);
  const internals = connector as unknown as Internals;
  internals.loggedIn = true;
  internals.bridge = bridge;
  internals.bridgeReady = true;
  return { connector, internals, logs };
};

describe("an account whose chats are filed under lids", () => {
  it.each([
    ["the lid known at link time", [OWN_LID]],
    ["the lid assigned after the link", [null, OWN_LID]],
  ])("finds the own chat with %s", async (_label, lids) => {
    const h = harness(lids);
    await h.internals.findSelf();

    expect(h.internals.selfDisplayName).toBe("Me (phone)");
    expect(h.internals.isOwnChat(OWN_LID)).toBe(true);
    expect(h.internals.isOwnChat(PHONE_JID)).toBe(true);
    expect(h.internals.isOwnChat("70000000000001@lid")).toBe(false);
    // Listed once, as the user, never again as a stranger.
    const names = h.connector.listContacts().map((row) => row.name);
    expect(names.filter((name) => name === "Me (phone)")).toEqual([]);
    expect(names[0]).toContain("the user's own account");
    expect(names).toHaveLength(3);
  });

  it("says the own chat is missing once per link, not per read", async () => {
    const h = harness([null]);
    await h.internals.findSelf();
    const refresh = (
      h.internals as unknown as { refreshBridgeChats: () => Promise<void> }
    ).refreshBridgeChats.bind(h.internals);
    await refresh();
    await refresh();
    expect(
      h.logs.filter((line) => line.includes("own chat not found"))
    ).toHaveLength(1);
  });
});
