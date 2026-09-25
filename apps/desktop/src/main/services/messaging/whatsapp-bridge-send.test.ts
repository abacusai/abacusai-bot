/**
 * A send with the bridge attached never touches the page driver, and a send
 * WhatsApp queued but did not confirm is not sent twice on retry.
 *
 * The report behind this: "the message was typed but didn't go through",
 * said about a message that was already on the user's phone. The page driver
 * had no way to know; the bridge does.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { isPackaged: false },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");
const { QueuedSendError } = await import("./whatsapp-bridge");

type Internals = {
  loggedIn: boolean;
  bridge: {
    ensure: () => Promise<boolean>;
    listChats: () => Promise<unknown[]>;
    sendText: (
      jid: string,
      text: string
    ) => Promise<{ id: string; ack: number }>;
    ackOf: (id: string) => Promise<number>;
  } | null;
  bridgeReady: boolean;
  bridgeChats: Array<{
    jid: string;
    name: string;
    isGroup: boolean;
    isMe: boolean;
  }>;
  sendChunk: (chatId: string, text: string) => Promise<void>;
  matchingOutCount: (chatId: string, text: string) => Promise<number>;
  sendTextNow: (chatId: string, text: string) => Promise<void>;
};

const connectorWith = (
  bridge: Internals["bridge"]
): { internals: Internals; domSends: string[]; logs: string[] } => {
  const logs: string[] = [];
  const connector = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);
  const internals = connector as unknown as Internals;
  internals.loggedIn = true;
  internals.bridge = bridge;
  internals.bridgeChats = [
    { jid: "919876543210@c.us", name: "Meghna", isGroup: false, isMe: false },
  ];
  const domSends: string[] = [];
  internals.sendChunk = async (_chatId, text) => {
    domSends.push(text);
  };
  internals.matchingOutCount = async () => 0;
  return { internals, domSends, logs };
};

describe("sending through the bridge", () => {
  it("uses the bridge and never the page driver when it is attached", async () => {
    const sent: Array<[string, string]> = [];
    const { internals, domSends } = connectorWith({
      ensure: async () => true,
      listChats: async () => [],
      sendText: async (jid, text) => {
        sent.push([jid, text]);
        return { id: `m${sent.length}`, ack: 1 };
      },
      ackOf: async () => 1,
    });

    await internals.sendTextNow("Meghna", "hello there");

    expect(sent).toEqual([["919876543210@c.us", "hello there"]]);
    expect(domSends).toEqual([]);
  });

  it("falls back to the page driver only when the bridge cannot attach", async () => {
    const { internals, domSends } = connectorWith({
      ensure: async () => false,
      listChats: async () => [],
      sendText: async () => {
        throw new Error("must not be called");
      },
      ackOf: async () => -1,
    });

    await internals.sendTextNow("Meghna", "hello there");

    expect(domSends).toEqual(["hello there"]);
  });

  it("surfaces a queued-not-acked send as a failure, and does not resend it once acked", async () => {
    let calls = 0;
    let ack = 0;
    const { internals, domSends, logs } = connectorWith({
      ensure: async () => true,
      listChats: async () => [],
      sendText: async () => {
        calls += 1;
        throw new QueuedSendError("queued-1", 0);
      },
      ackOf: async () => ack,
    });

    // First attempt: WhatsApp queued it, the server never answered. The
    // tool must hear a failure, not "sent".
    await expect(internals.sendTextNow("Meghna", "hi")).rejects.toThrow(
      /NOT resent/
    );
    expect(calls).toBe(1);

    // The connection came back and the queued message went out. The retry
    // asks after it first, and sends nothing.
    ack = 1;
    await internals.sendTextNow("Meghna", "hi");
    expect(calls).toBe(1);
    expect(logs.join("\n")).toMatch(/since been accepted, not resending/);
    expect(domSends).toEqual([]);
  });

  it("refuses a name it cannot resolve rather than sending somewhere", async () => {
    let refreshed = 0;
    const { internals } = connectorWith({
      ensure: async () => true,
      listChats: async () => {
        refreshed += 1;
        return [];
      },
      sendText: async () => {
        throw new Error("must not be called");
      },
      ackOf: async () => -1,
    });

    // Already attached, so the attach-time refresh is out of the picture:
    // the count below is the miss's own retry and nothing else.
    internals.bridgeReady = true;

    await expect(internals.sendTextNow("Nobody", "hi")).rejects.toThrow(
      /No WhatsApp chat called "Nobody"/
    );
    // One refresh of the list before giving up on the name.
    expect(refreshed).toBe(1);
  });
});

describe('who "me" is', () => {
  it("lists the user's own chat first as theirs, never as a contact with their name", async () => {
    const { internals } = connectorWith({
      ensure: async () => true,
      listChats: async () => [
        {
          jid: "919804585173@c.us",
          name: "Alex 2",
          isGroup: false,
          isMe: true,
        },
        {
          jid: "919876543210@c.us",
          name: "Meghna",
          isGroup: false,
          isMe: false,
        },
      ],
      sendText: async () => ({ id: "m", ack: 1 }),
      ackOf: async () => 1,
    });
    const me = internals as unknown as {
      self: string | null;
      selfJid: string | null;
      selfDisplayName: string | null;
      refreshBridgeChats: () => Promise<void>;
      listContacts: () => Array<{ chatId: string; name: string }>;
    };
    me.self = "+919804585173";
    me.selfJid = "919804585173@c.us";
    await me.refreshBridgeChats();

    const rows = me.listContacts();
    expect(rows[0]?.chatId).toBe("+919804585173");
    expect(rows[0]?.name).toMatch(/You .*own account/);
    expect(rows[0]?.name).toMatch(/"Alex 2"/);
    // The WhatsApp title of the own chat is not a second person.
    expect(rows.filter((row) => row.name === "Alex 2")).toEqual([]);
    expect(rows.map((row) => row.chatId)).toEqual(["+919804585173", "Meghna"]);
    expect(me.selfDisplayName).toBe("Alex 2");
  });
});

describe("who an inbound message is from", () => {
  const inboundWith = async (
    chats: Array<{
      jid: string;
      name: string;
      isGroup: boolean;
      isMe: boolean;
    }>,
    message: {
      id: string;
      jid: string;
      fromMe: boolean;
      senderName: string | null;
      text: string;
      t: number;
      chatIsMe?: boolean;
    },
    /** The page's own answer to "is this chat mine?", when asked. */
    ownChat: (jid: string) => boolean | null = () => false
  ): Promise<Array<{ userName: string; chatId: string }>> => {
    const seen: Array<{ userName: string; chatId: string }> = [];
    const connector = new WhatsAppWebConnector({
      onMessage: (m: { userName: string; chatId: string }) =>
        seen.push({ userName: m.userName, chatId: m.chatId }),
      onState: () => {},
      onLog: () => {},
    } as never);
    const internals = connector as unknown as {
      running: boolean;
      loggedIn: boolean;
      selfLookupDone: boolean;
      firstInboundSweep: boolean;
      self: string;
      selfJid: string;
      bridgeReady: boolean;
      bridgeChats: typeof chats;
      bridge: unknown;
      sweepBridgeInbound: () => Promise<void>;
    };
    internals.running = true;
    internals.loggedIn = true;
    internals.selfLookupDone = true;
    internals.firstInboundSweep = false;
    internals.self = "+919804585173";
    internals.selfJid = "919804585173@c.us";
    internals.bridgeReady = true;
    internals.bridgeChats = chats;
    internals.bridge = {
      listChats: async () => chats,
      drain: async () => ({ messages: [message], loggedOut: false }),
      isOwnChat: async (jid: string) => ownChat(jid),
    };
    await internals.sweepBridgeInbound();
    return seen;
  };

  it("names a direct chat's sender by the saved contact, not their profile name", async () => {
    // Saved as "Ma"; her WhatsApp profile happens to say the user's own name.
    const seen = await inboundWith(
      [{ jid: "919111111111@c.us", name: "Ma", isGroup: false, isMe: false }],
      {
        id: "m1",
        jid: "919111111111@c.us",
        fromMe: false,
        senderName: "Alex Rivera",
        text: "khawa hoyeche?",
        t: 1,
      }
    );
    expect(seen).toEqual([{ userName: "Ma", chatId: "Ma" }]);
  });

  it("keeps a message the user typed to themselves, on the own chat's lid id", async () => {
    // WhatsApp files the "Message yourself" chat under a lid, not the phone
    // jid the account is signed in as. The message is fromMe (the user
    // typed it on the phone) and used to be dropped as our own outgoing.
    const seen = await inboundWith(
      [{ jid: "123456789012345@lid", name: "You", isGroup: false, isMe: true }],
      {
        id: "m3",
        jid: "123456789012345@lid",
        fromMe: true,
        senderName: null,
        text: "what's on my calendar today",
        t: 3,
      }
    );
    expect(seen).toEqual([{ userName: "You", chatId: "+919804585173" }]);
  });

  it("keeps a self message on the lid id before the chat list has answered", async () => {
    // A fresh link: the list is still minutes away, so nothing names the
    // lid. The page is asked about the chat itself, and says it is the
    // user's own.
    const asked: string[] = [];
    const seen = await inboundWith(
      [],
      {
        id: "m5",
        jid: "123456789012345@lid",
        fromMe: true,
        senderName: null,
        text: "hello, are you there?",
        t: 5,
      },
      (jid) => {
        asked.push(jid);
        return jid === "123456789012345@lid";
      }
    );
    expect(seen).toEqual([
      { userName: "+919804585173", chatId: "+919804585173" },
    ]);
    expect(asked).toEqual(["123456789012345@lid"]);
  });

  it("trusts the flag the page put on the message, without asking", async () => {
    const asked: string[] = [];
    const seen = await inboundWith(
      [],
      {
        id: "m6",
        jid: "123456789012345@lid",
        fromMe: true,
        senderName: null,
        text: "what's on my calendar",
        t: 6,
        chatIsMe: true,
      },
      (jid) => {
        asked.push(jid);
        return null;
      }
    );
    expect(seen).toHaveLength(1);
    expect(asked).toEqual([]);
  });

  it("still drops own outgoing to someone the list has not named yet", async () => {
    const seen = await inboundWith(
      [],
      {
        id: "m7",
        jid: "919111111111@c.us",
        fromMe: true,
        senderName: null,
        text: "on my way",
        t: 7,
      },
      () => false
    );
    expect(seen).toEqual([]);
  });

  it("still drops the user's own outgoing to someone else", async () => {
    const seen = await inboundWith(
      [{ jid: "919111111111@c.us", name: "Ma", isGroup: false, isMe: false }],
      {
        id: "m4",
        jid: "919111111111@c.us",
        fromMe: true,
        senderName: null,
        text: "on my way",
        t: 4,
      }
    );
    expect(seen).toEqual([]);
  });

  it("names a group member by their own name, since the chat's is the group's", async () => {
    const seen = await inboundWith(
      [
        {
          jid: "1203@g.us",
          name: "School friendsss",
          isGroup: true,
          isMe: false,
        },
      ],
      {
        id: "m2",
        jid: "1203@g.us",
        fromMe: false,
        senderName: "Raj",
        text: "movie tonight?",
        t: 2,
      }
    );
    expect(seen).toEqual([{ userName: "Raj", chatId: "School friendsss" }]);
  });
});
