/**
 * A shared bot sits in groups too. Only the owner's own DM is the owner's
 * chat; a group, or anyone else, gets its own chat id, so the gateway takes
 * it through the sender path (approval first, then a held chat).
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  BrowserWindow: class {},
  shell: { openExternal: vi.fn() },
}));
vi.mock("../../bring-to-front", () => ({ parentWindow: () => undefined }));
vi.mock("../providers/abacus", () => ({ resolveAbacusApiKey: () => "key" }));
vi.mock("../providers/abacus-host", () => ({
  abacusRoutellmV1: () => "https://example.test/v1",
  abacusUserAgent: () => "test",
}));
vi.mock("./discord-web-connector", () => ({
  DISCORD_PARTITION: "persist:discord-web",
}));

const { AbacusChannelsConnector, entryChatId, SELF_CHAT_ID } =
  await import("./abacus-channels-connector");

describe("which chat a shared-bot message belongs to", () => {
  it("keeps the owner's own DM as the owner's chat", () => {
    expect(entryChatId({ sender: "Alex" })).toBe(SELF_CHAT_ID);
    expect(entryChatId({ sender: "Alex", chat: "dm", from_owner: true })).toBe(
      SELF_CHAT_ID
    );
  });

  it("gives a group its own chat, by the server's id", () => {
    expect(
      entryChatId({ sender: "Sam", chat: "group", chat_id: "-100123" })
    ).toBe("group:-100123");
  });

  it("treats someone other than the owner as another chat", () => {
    expect(
      entryChatId({
        sender: "Sam",
        chat: "dm",
        from_owner: false,
        chat_id: "9",
      })
    ).toBe("group:9");
  });

  it("reads a Telegram group from the sender line when the server names none", () => {
    expect(entryChatId({ sender: 'Sam in group "Weekend plans"' })).toBe(
      "group:Weekend plans"
    );
  });

  it("delivers a group message under the group's chat, not the owner's", () => {
    const seen: Array<{ userId: string; chatId: string }> = [];
    const connector = new AbacusChannelsConnector(
      {
        onMessage: (message) =>
          seen.push({ userId: message.userId, chatId: message.chatId }),
        onState: () => {},
        onLog: () => {},
      },
      "telegram"
    ) as unknown as { deliver: (entry: unknown) => void };
    connector.deliver({
      id: "m1",
      ts: 1,
      channel: "telegram",
      sender: "Sam",
      text: "hi",
      chat: "group",
      chat_id: "-100123",
    });
    expect(seen).toEqual([
      { userId: "group:-100123", chatId: "group:-100123" },
    ]);
  });

  it("answers in a group only as a reply to a message there", async () => {
    const connector = new AbacusChannelsConnector(
      { onMessage: () => {}, onState: () => {}, onLog: () => {} },
      "telegram"
    );
    await expect(connector.sendText("group:-100123", "hello")).rejects.toThrow(
      /only talks to you/
    );
  });
});
