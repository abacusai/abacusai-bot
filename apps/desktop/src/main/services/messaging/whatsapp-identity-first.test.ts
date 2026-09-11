/**
 * Who the account is comes before what its chat list holds.
 *
 * A tester linked WhatsApp and asked a bot to use it. The bridge attached
 * within seconds, and "me" was reported two minutes and forty-six seconds
 * later: the connector read the whole chat list first, behind WhatsApp's
 * history sync on a fresh link, and identity waited on it under the same
 * lock. Every tool call in between waited on a platform still "starting".
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { isPackaged: false },
  session: { fromPartition: () => ({}) },
  shell: { openExternal: async () => undefined },
}));

const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

type Internals = {
  loggedIn: boolean;
  bridge: unknown;
  bridgeReady: boolean;
  selfLookupDone: boolean;
  self: string | null;
  ensureBridge: () => Promise<boolean>;
  findSelf: () => Promise<void>;
};

const harness = () => {
  const calls: string[] = [];
  const logs: string[] = [];
  let releaseList: (() => void) | null = null;
  const bridge = {
    ensure: async () => {
      calls.push("ensure");
      return true;
    },
    myId: async () => {
      calls.push("myId");
      return { jid: "919800000314@c.us", digits: "919800000314" };
    },
    listChats: async () => {
      calls.push("listChats");
      // The sync-bound listing: answers only when the test lets it.
      await new Promise<void>((resolve) => {
        releaseList = resolve;
      });
      return [
        {
          jid: "919800000314@c.us",
          name: "Balajee",
          isGroup: false,
          isMe: true,
          unreadCount: 0,
        },
      ];
    },
  };
  const connector = new WhatsAppWebConnector({
    onMessage: () => {},
    onState: () => {},
    onLog: (line: string) => logs.push(line),
  } as never);
  const internals = connector as unknown as Internals;
  internals.loggedIn = true;
  internals.bridge = bridge;
  return {
    internals,
    calls,
    logs,
    releaseList: () => releaseList?.(),
  };
};

describe("a fresh link", () => {
  it("attaches without waiting for the chat list", async () => {
    const h = harness();
    await h.internals.ensureBridge();
    expect(h.calls).toEqual(["ensure"]);
    expect(h.internals.bridgeReady).toBe(true);
  });

  it("knows who it is before the chat list answers", async () => {
    const h = harness();
    await h.internals.ensureBridge();
    const lookup = h.internals.findSelf();
    // Let the microtasks run up to the point the listing blocks.
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(h.calls).toEqual(["ensure", "myId", "listChats"]);
    expect(h.internals.self).toBe("+919800000314");
    expect(h.logs.some((line) => line.includes("linked as +…0314"))).toBe(true);

    h.releaseList();
    await lookup;
    expect(h.logs.some((line) => line.includes('shows as "Balajee"'))).toBe(
      true
    );
  });

  it("still reads the list on a re-attach once identity is on record", async () => {
    const h = harness();
    h.internals.selfLookupDone = true;
    const ensured = h.internals.ensureBridge();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.calls).toEqual(["ensure", "listChats"]);
    h.releaseList();
    await ensured;
  });
});
