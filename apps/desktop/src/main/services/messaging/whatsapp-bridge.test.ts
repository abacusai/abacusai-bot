/**
 * The bridge's edges: how the app's chat ids become WhatsApp ids, what
 * counts as a sent message, and that every page script at least parses.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false },
}));

// The library is a build-time download; this file must not depend on
// whether the dev tree has run `pnpm vendor`. The "missing" test wants it
// missing, and nothing else here reads the disk.
vi.mock("fs", () => ({
  default: {
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
  },
}));

const {
  ACK_WAIT_MS,
  BRIDGE_PAGE_SCRIPTS,
  QueuedSendError,
  WhatsAppBridge,
  isConversationJid,
  isServerAck,
  resolveJid,
} = await import("./whatsapp-bridge");

const chats = [
  {
    jid: "919876543210@c.us",
    name: "Meghna",
    isGroup: false,
    isMe: false,
    unreadCount: 0,
  },
  {
    jid: "120363001@g.us",
    name: "School Friendsss",
    isGroup: true,
    isMe: false,
    unreadCount: 0,
  },
  {
    jid: "120363002@g.us",
    name: "School Friends",
    isGroup: true,
    isMe: false,
    unreadCount: 0,
  },
  {
    jid: "918888800000@c.us",
    name: "Raj",
    isGroup: false,
    isMe: false,
    unreadCount: 0,
  },
  {
    jid: "918888800001@c.us",
    name: "raj kumar",
    isGroup: false,
    isMe: false,
    unreadCount: 0,
  },
];

describe("resolveJid", () => {
  it("passes a WhatsApp id through untouched", () => {
    expect(resolveJid("120363001@g.us", chats)).toEqual({
      jid: "120363001@g.us",
    });
  });

  it("turns a number into a user chat, whatever the punctuation", () => {
    expect(resolveJid("+91 98765 43210", chats)).toEqual({
      jid: "919876543210@c.us",
    });
    expect(resolveJid("(919) 876-5432", chats)).toEqual({
      jid: "9198765432@c.us",
    });
  });

  it("resolves a name exactly before loosely", () => {
    // "School Friends" is a prefix of "School Friendsss": the exact match
    // wins, and the prefix rule never gets a vote.
    expect(resolveJid("School Friends", chats)).toEqual({
      jid: "120363002@g.us",
    });
    expect(resolveJid("meghna", chats)).toEqual({ jid: "919876543210@c.us" });
  });

  it("refuses an ambiguous name rather than guessing", () => {
    // "Raj" is exact for one chat, fine. "ra" is a prefix of two.
    expect(resolveJid("Raj", chats)).toEqual({ jid: "918888800000@c.us" });
    const result = resolveJid("ra", chats);
    expect("miss" in result && result.miss.ambiguous).toBe(true);
  });

  it("says when nothing matches", () => {
    const result = resolveJid("Nobody", chats);
    expect(result).toEqual({ miss: { ambiguous: false, candidates: [] } });
  });
});

describe("resolveJid: a person the user has no chat with yet", () => {
  // Two groups the user is in. Priya is in both and has no chat of her own;
  // Arjun is two different people, one per group.
  const family = {
    jid: "120363111@g.us",
    name: "Family",
    isGroup: true,
    isMe: false,
    unreadCount: 0,
  };
  const groupChats = [
    family,
    {
      jid: "120363222@g.us",
      name: "Priya's Farewell",
      isGroup: true,
      isMe: false,
      unreadCount: 0,
    },
    ...chats,
  ];
  const members = [
    {
      jid: "15550001234@c.us",
      ids: ["15550001234@c.us", "55500001@lid"],
      name: "Priya Shah",
      saved: true,
      groups: ["Family", "Priya's Farewell"],
    },
    {
      jid: "15550009999@c.us",
      ids: ["15550009999@c.us"],
      name: "Arjun",
      saved: true,
      groups: ["Family"],
    },
    {
      jid: "55500003@lid",
      ids: ["55500003@lid"],
      name: "Arjun",
      saved: true,
      groups: ["Priya's Farewell"],
    },
    // Meghna has a chat already: that chat is how she is reached.
    {
      jid: "919876543210@c.us",
      ids: ["919876543210@c.us"],
      name: "Meghna",
      saved: true,
      groups: ["Family"],
    },
  ];

  it("reaches a group member directly by name, never the group", () => {
    expect(resolveJid("Priya", groupChats, members)).toEqual({
      jid: "15550001234@c.us",
    });
    expect(resolveJid("priya shah", groupChats, members)).toEqual({
      jid: "15550001234@c.us",
    });
  });

  it("never lands a partial name in a group", () => {
    // "Fam" is only the start of a group's name: that is not who to send to.
    const result = resolveJid("Fam", groupChats, members);
    expect(result).toEqual({
      miss: {
        ambiguous: false,
        candidates: [{ name: "Family", to: "Family", isGroup: true }],
      },
    });
    // The group by its whole name is still the group.
    expect(resolveJid("family", groupChats, members)).toEqual({
      jid: family.jid,
    });
  });

  it("asks when two members share the name, telling them apart by number", () => {
    expect(resolveJid("Arjun", groupChats, members)).toEqual({
      miss: {
        ambiguous: true,
        candidates: [
          {
            name: "Arjun",
            to: "+15550009999",
            groups: ["Family"],
          },
          { name: "Arjun", to: "55500003@lid", groups: ["Priya's Farewell"] },
        ],
      },
    });
  });

  it("does not count a person with a chat twice", () => {
    expect(resolveJid("Meghna", groupChats, members)).toEqual({
      jid: "919876543210@c.us",
    });
  });

  it("never sends to a member known only by the name they gave themselves", () => {
    // Someone in a big group calls themselves "Ravi"; the user saved nobody so.
    const stranger = {
      jid: "15550007777@c.us",
      ids: ["15550007777@c.us"],
      name: "Ravi",
      saved: false,
      groups: ["Neighbourhood"],
    };
    expect(resolveJid("Ravi", groupChats, [stranger])).toEqual({
      miss: {
        ambiguous: false,
        candidates: [{ name: "Ravi", to: "Ravi", groups: ["Neighbourhood"] }],
      },
    });
  });

  it("settles a name among the user's chats before any group member", () => {
    // Two chats start with "Ravi": the user is asked, even though a member
    // in some group is called exactly "Ravi".
    const ravis = [
      ...groupChats,
      {
        jid: "15550001111@c.us",
        name: "Ravi Kumar",
        isGroup: false,
        isMe: false,
        unreadCount: 0,
      },
      {
        jid: "15550002222@c.us",
        name: "Ravi Mehta",
        isGroup: false,
        isMe: false,
        unreadCount: 0,
      },
    ];
    const member = {
      jid: "15550007777@c.us",
      ids: ["15550007777@c.us"],
      name: "Ravi",
      saved: true,
      groups: ["Neighbourhood"],
    };
    const result = resolveJid("Ravi", ravis, [member]);
    expect("miss" in result && result.miss.ambiguous).toBe(true);
    expect(
      "miss" in result && result.miss.candidates.map((row) => row.name)
    ).toEqual(["Ravi Kumar", "Ravi Mehta"]);
  });

  it("lists the closest names, with the groups a member is in, on a miss", () => {
    const result = resolveJid("Priyanka Shah", groupChats, members);
    expect(result).toEqual({
      miss: {
        ambiguous: false,
        candidates: [
          {
            name: "Priya's Farewell",
            to: "Priya's Farewell",
            isGroup: true,
          },
          {
            name: "Priya Shah",
            to: "Priya Shah",
            groups: ["Family", "Priya's Farewell"],
          },
        ],
      },
    });
  });
});

describe("which ids are conversations", () => {
  it.each([
    ["919876543210@c.us", true, "a person, by number"],
    ["919876543210@s.whatsapp.net", true, "a person, by the wire form"],
    ["196083074474167@lid", true, "a person, by lid"],
    ["120363001@g.us", true, "a group"],
    ["Meghna", true, "a display name"],
    ["+15550001234", true, "a number"],
    ["status@broadcast", false, "the contacts' Status updates"],
    ["1698765432@broadcast", false, "a broadcast list"],
    ["120363025246125486@newsletter", false, "a channel"],
    [" Status@Broadcast ", false, "any casing or padding"],
  ])("%s is %s (%s)", (jid, expected) => {
    expect(isConversationJid(jid)).toBe(expected);
  });

  it("keeps a Status, broadcast list or channel out of the drain and the chat list", async () => {
    const message = (id: string, jid: string) => ({
      id,
      jid,
      fromMe: false,
      senderName: "Ana",
      text: "hello",
      t: 1,
    });
    const chat = (jid: string) => ({
      jid,
      name: jid,
      isGroup: false,
      isMe: false,
      unreadCount: 1,
    });
    const bridge = new WhatsAppBridge({
      run: async (script: string) =>
        (script === BRIDGE_PAGE_SCRIPTS.DRAIN_SCRIPT
          ? {
              messages: [
                message("a", "status@broadcast"),
                message("b", "919876543210@c.us"),
                message("c", "120363025246125486@newsletter"),
                message("d", "1698765432@broadcast"),
                message("e", "120363001@g.us"),
              ],
              loggedOut: false,
            }
          : [
              chat("status@broadcast"),
              chat("919876543210@c.us"),
              chat("120363025246125486@newsletter"),
            ]) as never,
      raw: async () => undefined,
      log: () => {},
    });

    const drained = await bridge.drain();
    expect(drained.messages.map((row) => row.id)).toEqual(["b", "e"]);
    const listed = await bridge.listChats({ onlyUnread: true });
    expect(listed?.map((row) => row.jid)).toEqual(["919876543210@c.us"]);
  });
});

describe("what counts as sent", () => {
  it("is the server's ack, nothing less", () => {
    expect(isServerAck(-1)).toBe(false);
    expect(isServerAck(0)).toBe(false);
    expect(isServerAck(1)).toBe(true);
    expect(isServerAck(3)).toBe(true);
  });

  it("reports a queued send as its own error, carrying the id", async () => {
    const bridge = new WhatsAppBridge({
      run: async () => ({ ok: true, id: "msg-1", ack: 0 }) as never,
      raw: async () => undefined,
      log: () => {},
    });
    await expect(bridge.sendText("x@c.us", "hi")).rejects.toBeInstanceOf(
      QueuedSendError
    );
    try {
      await bridge.sendText("x@c.us", "hi");
    } catch (error) {
      expect((error as InstanceType<typeof QueuedSendError>).messageId).toBe(
        "msg-1"
      );
      expect(String((error as Error).message)).toMatch(/NOT resent/);
    }
  });

  it("returns the id and ack of an accepted send", async () => {
    const bridge = new WhatsAppBridge({
      run: async () => ({ ok: true, id: "msg-2", ack: 2 }) as never,
      raw: async () => undefined,
      log: () => {},
    });
    await expect(bridge.sendText("x@c.us", "hi")).resolves.toEqual({
      id: "msg-2",
      ack: 2,
    });
  });

  it("throws when WhatsApp refuses, with its reason", async () => {
    const bridge = new WhatsAppBridge({
      run: async () => ({ ok: false, error: "not a contact" }) as never,
      raw: async () => undefined,
      log: () => {},
    });
    await expect(bridge.sendText("x@c.us", "hi")).rejects.toThrow(
      /not a contact/
    );
  });

  it("waits a bounded time for the ack", () => {
    expect(ACK_WAIT_MS).toBeGreaterThanOrEqual(10_000);
    expect(ACK_WAIT_MS).toBeLessThanOrEqual(60_000);
  });
});

describe("page scripts", () => {
  // The scripts are strings the page evaluates; a typo in one is a runtime
  // "script failed" on a tester's machine, not a build error here. Parsing
  // each as the async function it becomes catches that before it ships.
  const AsyncFunction = Object.getPrototypeOf(async () => {})
    .constructor as new (...args: string[]) => unknown;
  for (const [name, script] of Object.entries(BRIDGE_PAGE_SCRIPTS)) {
    it(`${name} parses`, () => {
      expect(() => new AsyncFunction("args", script)).not.toThrow();
    });
  }
});

describe("asking whether a chat is the user's own", () => {
  it("relays the page's answer, and null when the page did not answer", async () => {
    const scripts: string[] = [];
    let answer: unknown = { isMe: true };
    const bridge = new WhatsAppBridge({
      run: async (script: string) => {
        scripts.push(script);
        return answer as never;
      },
      raw: async () => undefined,
      log: () => {},
    });
    expect(await bridge.isOwnChat("123@lid")).toBe(true);
    answer = { isMe: false };
    expect(await bridge.isOwnChat("456@c.us")).toBe(false);
    answer = null;
    expect(await bridge.isOwnChat("789@c.us")).toBeNull();
    expect(scripts.every((s) => s.includes("getMaybeMeLidUser"))).toBe(true);
  });
});

describe("attaching", () => {
  it("re-uses a page where the library already attached", async () => {
    const calls: string[] = [];
    const bridge = new WhatsAppBridge({
      run: async (script: string) => {
        calls.push(script);
        return { present: true, ready: true } as never;
      },
      raw: async () => {
        throw new Error("must not inject twice");
      },
      log: () => {},
    });
    expect(await bridge.ensure()).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("falls back when the vendored library is missing", async () => {
    const logs: string[] = [];
    const bridge = new WhatsAppBridge({
      run: async () => ({ present: false, ready: false }) as never,
      raw: async () => undefined,
      log: (line) => logs.push(line),
    });
    expect(await bridge.ensure()).toBe(false);
    expect(logs.join("\n")).toMatch(/pnpm vendor/);
  });
});
