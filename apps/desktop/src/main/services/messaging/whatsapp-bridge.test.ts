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
    expect("error" in result && result.error).toMatch(/More than one/);
  });

  it("says when nothing matches", () => {
    const result = resolveJid("Nobody", chats);
    expect("error" in result && result.error).toMatch(/No WhatsApp chat/);
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
