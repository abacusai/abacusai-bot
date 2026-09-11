/**
 * Sender conversations: one dedicated session per (bot, platform chat).
 *
 * The store side of the audience fix — a bot answering a remote sender must
 * do it in a room where that sender is the only audience, and this table is
 * how the gateway finds that room again.
 */
import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  botForSession,
  botSessionIds,
  createBot,
  getSenderSession,
  recordBotSession,
  recordSenderSession,
  removeSenderSession,
  removeSenderSessionsForBot,
  senderSessionKey,
} from "./bot-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-sender-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

describe("the sender-session table", () => {
  it("round-trips a record under its route key", () => {
    const key = senderSessionKey("bot-1", "whatsapp", "Gautam Bansal");
    expect(getSenderSession(key)).toBeNull();

    recordSenderSession(key, {
      botId: "bot-1",
      workspaceId: "ws-1",
      sessionId: "sess-1",
      platform: "whatsapp",
      senderName: "Gautam Bansal",
    });

    expect(getSenderSession(key)?.sessionId).toBe("sess-1");

    removeSenderSession(key);
    expect(getSenderSession(key)).toBeNull();
  });

  it("resolves a sender session to its bot, for the persona env", () => {
    const bot = createBot({
      name: "WhatsApp Bot",
      title: "",
      description: "x",
    });
    recordBotSession(bot.id, "ws-1", "forever-chat");
    recordSenderSession(senderSessionKey(bot.id, "whatsapp", "Gautam"), {
      botId: bot.id,
      workspaceId: "ws-1",
      sessionId: "sender-sess",
      platform: "whatsapp",
      senderName: "Gautam",
    });

    expect(botForSession("forever-chat")?.id).toBe(bot.id);
    expect(botForSession("sender-sess")?.id).toBe(bot.id);
    expect(botForSession("unrelated")).toBeNull();
  });

  it("hides sender sessions from the Sessions list — they live under the bot", () => {
    const bot = createBot({ name: "B", title: "", description: "x" });
    recordBotSession(bot.id, "ws-1", "forever-chat");
    recordSenderSession(senderSessionKey(bot.id, "whatsapp", "G"), {
      botId: bot.id,
      workspaceId: "ws-1",
      sessionId: "sender-sess",
      platform: "whatsapp",
      senderName: "G",
    });

    const hidden = botSessionIds();
    expect(hidden).toContain("forever-chat");
    // The bot set the conversation up, so the user looks for it under the
    // bot in the Bots pane — not among their own sessions.
    expect(hidden).toContain("sender-sess");
  });

  it("drops a deleted bot's routes and keeps the other bot's", () => {
    recordSenderSession(senderSessionKey("bot-1", "whatsapp", "G"), {
      botId: "bot-1",
      workspaceId: "ws",
      sessionId: "s1",
      platform: "whatsapp",
      senderName: "G",
    });
    recordSenderSession(senderSessionKey("bot-2", "whatsapp", "G"), {
      botId: "bot-2",
      workspaceId: "ws",
      sessionId: "s2",
      platform: "whatsapp",
      senderName: "G",
    });

    removeSenderSessionsForBot("bot-1");

    expect(
      getSenderSession(senderSessionKey("bot-1", "whatsapp", "G"))
    ).toBeNull();
    expect(
      getSenderSession(senderSessionKey("bot-2", "whatsapp", "G"))?.sessionId
    ).toBe("s2");
  });
});
