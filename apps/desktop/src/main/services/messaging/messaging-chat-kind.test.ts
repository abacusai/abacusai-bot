/**
 * Each connector says whether a chat is a group or one person. Auto-reply
 * leans on it: a group is answered only when approved by name, the private-
 * chats switch covers one person only, and an unknown chat is never taken
 * for one person. One table per connector.
 */
import { describe, expect, it } from "vitest";

import { entryChatKind } from "./abacus-channels-connector";
import { DiscordWebConnector } from "./discord-web-connector";
import { telegramPeerKind } from "./telegram-web-connector";
import { whatsAppChatKind, whatsAppKindByName } from "./whatsapp-web-connector";

describe("Telegram Web", () => {
  it.each([
    ["a person's peer id", "12345", "direct"],
    ["a group or channel's negative peer id", "-100777", "group"],
    ["an id the page did not give as a number", "@somebody", undefined],
  ])("%s", (_case, peerId, kind) => {
    expect(telegramPeerKind(peerId)).toBe(kind);
  });
});

describe("WhatsApp", () => {
  it.each([
    ["a listed person", "111@c.us", { isGroup: false }, "direct"],
    ["a listed group", "222@g.us", { isGroup: true }, "group"],
    ["a group not yet listed, by its id", "222@g.us", undefined, "group"],
    ["a person not yet listed", "111@c.us", undefined, undefined],
  ])("off the bridge: %s", (_case, jid, chat, kind) => {
    expect(whatsAppChatKind(jid, chat)).toBe(kind);
  });

  it.each([
    ["a listed group", [{ name: "Family", isGroup: true }], "group"],
    ["a listed person", [{ name: "Family", isGroup: false }], "direct"],
    [
      "a person and a group sharing the name",
      [
        { name: "Family", isGroup: true },
        { name: "Family", isGroup: false },
      ],
      undefined,
    ],
    ["a name the chat list does not have yet", [], undefined],
  ])("off the page, by name: %s", (_case, chats, kind) => {
    expect(whatsAppKindByName("Family", chats, [])).toBe(kind);
  });
});

describe("shared Abacus lanes", () => {
  it.each([
    [
      "the owner's own DM",
      { chat: "dm", from_owner: true, sender: "Sam" },
      { kind: "direct" },
    ],
    [
      "a group entry",
      { chat: "group", chat_id: "-100777", from_owner: false, sender: "Lee" },
      { kind: "group" },
    ],
    [
      "a group named only in the sender line",
      { from_owner: false, sender: 'Lee in group "Crypto deals"' },
      { kind: "group", chatName: "Crypto deals" },
    ],
    [
      "someone else's DM",
      { chat: "dm", chat_id: "555", from_owner: false, sender: "Jordan" },
      {},
    ],
  ])("%s", (_case, entry, expected) => {
    expect(entryChatKind(entry)).toEqual(expected);
  });
});

describe("Discord Web", () => {
  it("a server mention is a group", async () => {
    const messages: Array<{ kind?: string }> = [];
    const c = new DiscordWebConnector({
      onMessage: (message) => messages.push(message),
      onState: () => {},
      onLog: () => {},
    });
    const inner = c as unknown as {
      firstInboundSweep: boolean;
      run: () => Promise<unknown>;
      sweepGuildMentions: () => Promise<void>;
    };
    inner.run = async () => [{ guildId: "22", name: "SolidJS", mentions: 1 }];
    inner.firstInboundSweep = false;
    await inner.sweepGuildMentions();

    expect(messages.map((message) => message.kind)).toEqual(["group"]);
  });
});
