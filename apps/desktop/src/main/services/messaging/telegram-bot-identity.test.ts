import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  botUsernameCandidate,
  isUsernameRejected,
  parseBotFatherToken,
  readTelegramBotState,
  resolveBotToken,
  saveTelegramBotState,
  updateToInbound,
} from "./telegram-bot-identity";

// A token in BotFather's real shape, assembled so no working credential ever
// sits in the repo.
const FAKE_TOKEN = `${"1234567890"}:${"AAF".padEnd(35, "x")}`;

describe("parseBotFatherToken", () => {
  it("finds the token inside BotFather's Done! message", () => {
    const reply = [
      "Done! Congratulations on your new bot. You will find it at",
      "t.me/Something_bot.",
      "Use this token to access the HTTP API:",
      FAKE_TOKEN,
      "Keep your token secure and store it safely.",
    ].join("\n");
    expect(parseBotFatherToken(reply)).toBe(FAKE_TOKEN);
  });

  it("returns null for prompts and refusals", () => {
    expect(
      parseBotFatherToken("Alright, a new bot. How are we going to call it?")
    ).toBeNull();
    expect(
      parseBotFatherToken("Sorry, this username is already taken.")
    ).toBeNull();
  });
});

describe("isUsernameRejected", () => {
  it("recognises the taken and invalid refusals", () => {
    expect(isUsernameRejected("Sorry, this username is already taken.")).toBe(
      true
    );
    expect(isUsernameRejected("Sorry, this username is invalid.")).toBe(true);
  });

  it("never reads a token reply as a refusal", () => {
    // "Sorry" wording plus a token cannot happen, but the guard is cheap:
    // the token's presence always wins.
    expect(isUsernameRejected(`Done! Use this token: ${FAKE_TOKEN}`)).toBe(
      false
    );
  });
});

describe("botUsernameCandidate", () => {
  it("meets Telegram's rules: 5-32 chars, ends in bot", () => {
    for (let i = 0; i < 20; i++) {
      const candidate = botUsernameCandidate();
      expect(candidate.length).toBeGreaterThanOrEqual(5);
      expect(candidate.length).toBeLessThanOrEqual(32);
      expect(candidate.toLowerCase().endsWith("bot")).toBe(true);
      expect(candidate).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });
});

describe("updateToInbound", () => {
  const update = (message: object): { update_id: number; message: object } => ({
    update_id: 1,
    message,
  });

  it("maps a private text message", () => {
    expect(
      updateToInbound(
        update({
          text: "hello",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Sree", last_name: "Dey" },
        }) as never
      )
    ).toEqual({
      userId: "42",
      userName: "Sree Dey",
      chatId: "42",
      text: "hello",
    });
  });

  it("carries a /start deep-link payload — the self-link proof", () => {
    expect(
      updateToInbound(
        update({
          text: "/start link-a1b2c3d4e5f6",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Sree" },
        }) as never
      )
    ).toMatchObject({ startPayload: "link-a1b2c3d4e5f6" });
  });

  it("gives a bare /start no payload", () => {
    const inbound = updateToInbound(
      update({
        text: "/start",
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Sree" },
      }) as never
    );
    expect(inbound?.startPayload).toBeUndefined();
    // Mid-sentence mentions of /start are conversation, not a handshake.
    expect(
      updateToInbound(
        update({
          text: "how do I /start link-abc things",
          chat: { id: 42, type: "private" },
          from: { id: 42, first_name: "Sree" },
        }) as never
      )?.startPayload
    ).toBeUndefined();
  });

  it("drops unaddressed groups, bots, and non-text updates", () => {
    expect(
      updateToInbound(
        update({
          text: "hi",
          chat: { id: -100, type: "supergroup" },
          from: { id: 42 },
        }) as never,
        "HelperBot"
      )
    ).toBeNull();
    expect(
      updateToInbound(
        update({
          text: "hi",
          chat: { id: 7, type: "private" },
          from: { id: 7, is_bot: true },
        }) as never
      )
    ).toBeNull();
    expect(
      updateToInbound(
        update({ chat: { id: 7, type: "private" }, from: { id: 7 } }) as never
      )
    ).toBeNull();
  });

  it("accepts a group message that mentions the bot, stripping the tag", () => {
    expect(
      updateToInbound(
        update({
          text: "@HelperBot check my PR please",
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, first_name: "Sree" },
        }) as never,
        "HelperBot"
      )
    ).toEqual({
      userId: "42",
      userName: "Sree",
      chatId: "-100",
      text: "check my PR please",
    });
  });

  it("matches the mention case-insensitively, anywhere in the text", () => {
    expect(
      updateToInbound(
        update({
          text: "can you look at this @helperbot ?",
          chat: { id: -100, type: "group" },
          from: { id: 42, first_name: "Sree" },
        }) as never,
        "HelperBot"
      )?.text
    ).toBe("can you look at this ?");
  });

  it("does not treat @HelperBotFan as a mention of @HelperBot", () => {
    expect(
      updateToInbound(
        update({
          text: "ask @HelperBotFan about it",
          chat: { id: -100, type: "group" },
          from: { id: 42 },
        }) as never,
        "HelperBot"
      )
    ).toBeNull();
  });

  it("accepts a group reply to one of the bot's own messages", () => {
    expect(
      updateToInbound(
        update({
          text: "yes, do that",
          chat: { id: -100, type: "supergroup" },
          from: { id: 42, first_name: "Sree" },
          reply_to_message: { from: { is_bot: true, username: "HelperBot" } },
        }) as never,
        "HelperBot"
      )?.text
    ).toBe("yes, do that");
  });

  it("ignores a group reply to some other bot", () => {
    expect(
      updateToInbound(
        update({
          text: "yes, do that",
          chat: { id: -100, type: "supergroup" },
          from: { id: 42 },
          reply_to_message: { from: { is_bot: true, username: "OtherBot" } },
        }) as never,
        "HelperBot"
      )
    ).toBeNull();
  });

  it("drops a bare tag with nothing asked, and groups before getMe", () => {
    expect(
      updateToInbound(
        update({
          text: "@HelperBot",
          chat: { id: -100, type: "group" },
          from: { id: 42 },
        }) as never,
        "HelperBot"
      )
    ).toBeNull();
    expect(
      updateToInbound(
        update({
          text: "@HelperBot hello",
          chat: { id: -100, type: "group" },
          from: { id: 42 },
        }) as never,
        null
      )
    ).toBeNull();
  });

  it("delivers a photo with no words as a message with media", () => {
    const inbound = updateToInbound(
      update({
        photo: [
          { file_id: "small", file_size: 10 },
          { file_id: "full", file_size: 100 },
        ],
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Sree" },
      }) as never
    );

    expect(inbound?.text).toBe("");
    expect(inbound?.media).toEqual([
      { fileId: "full", name: "photo.jpg", mimeType: "image/jpeg" },
    ]);
  });

  it("uses the caption as the text and keeps the document's own name", () => {
    const inbound = updateToInbound(
      update({
        caption: "the invoice",
        document: {
          file_id: "doc1",
          file_name: "invoice.pdf",
          mime_type: "application/pdf",
        },
        chat: { id: 42, type: "private" },
        from: { id: 42, first_name: "Sree" },
      }) as never
    );

    expect(inbound?.text).toBe("the invoice");
    expect(inbound?.media?.[0]).toEqual({
      fileId: "doc1",
      name: "invoice.pdf",
      mimeType: "application/pdf",
    });
  });

  it("still drops channels even when the bot is named", () => {
    expect(
      updateToInbound(
        update({
          text: "@HelperBot hello",
          chat: { id: -100, type: "channel" },
          from: { id: 42 },
        }) as never,
        "HelperBot"
      )
    ).toBeNull();
  });

  it("falls back to the username when there is no display name", () => {
    expect(
      updateToInbound(
        update({
          text: "yo",
          chat: { id: 9, type: "private" },
          from: { id: 9, username: "sree" },
        }) as never
      )?.userName
    ).toBe("sree");
  });
});

describe("state file", () => {
  let home: string;
  const previousHome = process.env.ABACUSAI_BOT_HOME;
  const previousToken = process.env.TELEGRAM_BOT_TOKEN;

  beforeEach(() => {
    home = fs.mkdtempSync(path.join(os.tmpdir(), "tg-bot-state-"));
    process.env.ABACUSAI_BOT_HOME = home;
    delete process.env.TELEGRAM_BOT_TOKEN;
  });

  afterEach(() => {
    if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
    else process.env.ABACUSAI_BOT_HOME = previousHome;
    if (previousToken == null) delete process.env.TELEGRAM_BOT_TOKEN;
    else process.env.TELEGRAM_BOT_TOKEN = previousToken;
    fs.rmSync(home, { recursive: true, force: true });
  });

  it("round-trips and merges patches", () => {
    expect(readTelegramBotState()).toEqual({});
    saveTelegramBotState({ token: FAKE_TOKEN, username: "SomeBot" });
    saveTelegramBotState({ selfChatId: "42" });
    expect(readTelegramBotState()).toEqual({
      token: FAKE_TOKEN,
      username: "SomeBot",
      selfChatId: "42",
    });
  });

  it("lets the environment win over the stored token", () => {
    saveTelegramBotState({ token: FAKE_TOKEN });
    expect(resolveBotToken(readTelegramBotState())).toBe(FAKE_TOKEN);
    process.env.TELEGRAM_BOT_TOKEN = "111111:envtoken";
    expect(resolveBotToken(readTelegramBotState())).toBe("111111:envtoken");
  });
});
