/**
 * A chat the store has not loaded is answered, not chased by reloading
 * WhatsApp Web. The reload path detaches the bridge, drops its inbound
 * queue and restarts WhatsApp's sync — four reads in a turn kept a fresh
 * link "syncing" for fifteen minutes.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  app: { getPath: () => "/tmp" },
  session: { fromPartition: () => ({}) },
}));

const { WhatsAppWebConnector } = await import("./whatsapp-web-connector");

describe("reading a chat the store has not loaded", () => {
  it("answers without reloading the page while the bridge is attached", async () => {
    const logs: string[] = [];
    const connector = new WhatsAppWebConnector({
      onMessage: () => {},
      onState: () => {},
      onLog: (line: string) => logs.push(line),
    } as never);
    const internals = connector as unknown as {
      loggedIn: boolean;
      bridge: unknown;
      bridgeChats: unknown[];
      ensureBridge: () => Promise<boolean>;
      openChat: () => Promise<unknown>;
      readChatNow: (chatId: string, limit: number) => Promise<unknown[]>;
    };
    internals.loggedIn = true;
    internals.bridgeChats = [
      { jid: "919111111111@c.us", name: "Ma", isGroup: false, isMe: false },
    ];
    internals.ensureBridge = async () => true;
    internals.bridge = {
      readChat: async () => ({
        ok: false,
        reason: "Chat not found for 919111111111@c.us",
      }),
      listChats: async () => internals.bridgeChats,
    };
    internals.openChat = async () => {
      throw new Error("must not navigate the page");
    };

    await expect(internals.readChatNow("Ma", 20)).rejects.toThrow(
      /has not loaded the chat "Ma"/
    );
    expect(logs.some((line) => line.includes("not reloading"))).toBe(true);
  });
});
