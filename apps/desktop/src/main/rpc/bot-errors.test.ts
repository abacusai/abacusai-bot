/**
 * Typed bot errors (spec 03 §24.4, §24.5): the 50-bot limit, channel-bot
 * edits, blank fields, `openChat` on an unknown bot and a delete of a gone
 * bot reach the client as defined codes the UI branches on, from the real
 * bot store and service, while legacy IPC keeps the same `Error` messages.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MAX_BOTS } from "#shared/bots";

import { BotService } from "../services/bots/bot-service";
import {
  assertNotChannelBot,
  createBot,
  removeBot,
  updateBot,
} from "../services/bots/bot-store";
import { connectInProcess, fakeDeps } from "./testing";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "bot-errors-"));
  process.env.ABACUSAI_BOT_HOME = home;
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;
  fs.rmSync(home, { recursive: true, force: true });
});

/** The legacy IPC rejection text: Electron sends `String(error)`. */
const legacyText = (run: () => unknown): string => {
  try {
    run();
  } catch (error) {
    return String(error);
  }
  throw new Error("did not throw");
};

const connect = () => {
  const service = new BotService({
    resolveDefaultWorkspaceId: () => "ws",
    isWorkspaceUsable: () => true,
    sessionExists: () => false,
    createSession: () => ({ id: "s-1" }),
    findOwnedSession: () => null,
    updateSessionLabel: () => undefined,
    startSession: async () => ({ success: true }),
    sendMessage: () => undefined,
    removeSession: () => undefined,
    updateSessionModel: () => undefined,
    effectiveModel: () => null,
    emitChanged: () => undefined,
  });
  // As ServiceHost's createBot/updateBot/deleteBot/openBotChat.
  const serviceHost = {
    createBot: (input: never, id?: string) => service.create(input, id),
    updateBot: (id: string, changes: never) => {
      assertNotChannelBot(id, "edited");
      return service.update(id, changes);
    },
    deleteBot: (id: string) => {
      assertNotChannelBot(id, "deleted");
      service.delete(id);
    },
    openBotChat: (botId: string) => service.openChat(botId),
    listBots: () => service.list(),
  };
  return connectInProcess(fakeDeps({ serviceHost })).client;
};

describe("typed bot errors (spec 03 §24.4)", () => {
  it("the 51st bot is PRECONDITION_FAILED bot-limit; legacy keeps its message", async () => {
    for (let index = 0; index < MAX_BOTS; index += 1)
      createBot({ name: `B${index}`, description: "x" }, `bot-${index}`);
    const client = connect();

    await expect(
      client.db.bots.insert({
        id: "bot-extra",
        name: "One more",
        description: "x",
      })
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      defined: true,
      data: { reason: "bot-limit" },
    });
    expect(
      legacyText(() => createBot({ name: "Legacy", description: "x" }))
    ).toBe(`Error: At most ${MAX_BOTS} bots are supported.`);
  });

  it("blank fields are BAD_REQUEST on insert and update", async () => {
    const client = connect();
    await expect(
      client.db.bots.insert({ id: "bot-a", name: "   ", description: "x" })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", defined: true });

    createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    await expect(
      client.db.bots.update({ id: "bot-ada", patch: { description: "  " } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", defined: true });
    expect(legacyText(() => updateBot("bot-ada", { name: " " }))).toBe(
      "Error: A bot needs a name."
    );
  });

  it("a channel bot's edit or delete is FORBIDDEN channel-bot", async () => {
    createBot(
      { name: "Mirror", description: "Mirrors", channel: "telegram" },
      "bot-mirror"
    );
    const client = connect();
    await expect(
      client.db.bots.update({ id: "bot-mirror", patch: { name: "New" } })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      defined: true,
      data: { reason: "channel-bot" },
      message: "This bot mirrors your Telegram chat and can't be edited.",
    });
    await expect(
      client.db.bots.delete({ id: "bot-mirror" })
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      data: { reason: "channel-bot" },
    });
    expect(legacyText(() => assertNotChannelBot("bot-mirror", "deleted"))).toBe(
      "Error: This bot mirrors your Telegram chat and can't be deleted."
    );
  });

  it("openChat on an unknown bot is NOT_FOUND bot", async () => {
    const client = connect();
    await expect(
      client.bots.openChat({ botId: "bot-gone" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      defined: true,
      data: { entity: "bot", id: "bot-gone" },
    });
  });

  it("a delete of a bot already gone is NOT_FOUND bot (the idempotent-delete signal, §24.5)", async () => {
    createBot({ name: "Ada", description: "Counts" }, "bot-ada");
    removeBot("bot-ada");
    const client = connect();
    await expect(
      client.db.bots.delete({ id: "bot-ada" })
    ).rejects.toMatchObject({
      code: "NOT_FOUND",
      defined: true,
      data: { entity: "bot", id: "bot-ada" },
    });
  });
});
