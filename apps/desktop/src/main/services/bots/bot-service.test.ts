import fs from "fs";
import os from "os";
import path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BotService, type BotServiceCallbacks } from "./bot-service";
import {
  getBot,
  getSenderSession,
  personaPath,
  recordBotSession,
  removeSenderSession,
  senderSessionKey,
} from "./bot-store";

let home: string;
const previousHome = process.env.ABACUSAI_BOT_HOME;

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-bot-service-"));
  process.env.ABACUSAI_BOT_HOME = home;
});

afterEach(() => {
  if (previousHome == null) delete process.env.ABACUSAI_BOT_HOME;
  else process.env.ABACUSAI_BOT_HOME = previousHome;

  fs.rmSync(home, { recursive: true, force: true });
});

const makeCallbacks = (
  overrides: Partial<BotServiceCallbacks> = {}
): BotServiceCallbacks => {
  let sessionCounter = 0;

  return {
    resolveDefaultWorkspaceId: () => "ws-default",
    isWorkspaceUsable: () => true,
    sessionExists: () => true,
    createSession: () => ({ id: `session-${++sessionCounter}` }),
    findOwnedSession: () => null,
    updateSessionLabel: vi.fn(),
    startSession: vi.fn().mockResolvedValue({ success: true }),
    sendMessage: vi.fn(),
    removeSession: vi.fn(),
    updateSessionModel: vi.fn(),
    defaultModel: () => null,
    emitChanged: vi.fn(),
    ...overrides,
  };
};

describe("creating a bot", () => {
  it("writes the persona file with the identity in it", () => {
    const service = new BotService(makeCallbacks());

    const bot = service.create({
      name: "Scout",
      title: "Research Scout",
      description: "Watch the news.",
    });

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain("# Scout");
    expect(persona).toContain("**Role:** Research Scout");
    expect(persona).toContain(
      "**Your mission — yours alone:** Watch the news."
    );
  });

  it("tells the bot to introduce itself once, not after every tool result", () => {
    // A turn with tool calls is several model replies; a model that read
    // "first turn" as "first reply" greeted three times in a row, and the
    // thread hides the tool cards that would have explained the gaps.
    const service = new BotService(makeCallbacks());

    const bot = service.create({ name: "Scout", description: "Watch." });

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain("Introduce yourself once, in your first message");
    expect(persona).toContain("Do not greet again");
  });
});

describe("opening the forever chat", () => {
  it("mints a session on first open and kicks the bot off", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const handle = await service.openChat(bot.id);

    expect(handle.sessionId).toBe("session-1");
    expect(getBot(bot.id)?.sessionId).toBe("session-1");
    expect(callbacks.updateSessionLabel).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      "Scout"
    );
    expect(callbacks.sendMessage).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      expect.stringContaining("[first run]")
    );
    // The kickstart is the user message every tool round keeps answering, so
    // it has to say the greeting is a one-off itself.
    expect(callbacks.sendMessage).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      expect.stringContaining("no second greeting")
    );
  });

  it("reuses the recorded session while it exists", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const first = await service.openChat(bot.id);
    const second = await service.openChat(bot.id);

    expect(second.sessionId).toBe(first.sessionId);
    // The kickstart belongs to the chat's creation, not to every open.
    expect(callbacks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("recreates the chat after its session died, never a duplicate", async () => {
    const callbacks = makeCallbacks({ sessionExists: () => false });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);
    const handle = await service.openChat(bot.id);

    expect(handle.sessionId).toBe("session-2");
    expect(getBot(bot.id)?.sessionId).toBe("session-2");
  });

  it("introduces itself once ever, not once per remint", async () => {
    // The session store lost across a relaunch remints the chat — but it is
    // the same ongoing conversation to the user, who once got a fresh
    // self-introduction on Telegram for every remint.
    const callbacks = makeCallbacks({ sessionExists: () => false });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);
    await service.openChat(bot.id);
    await service.openChat(bot.id);

    const kickstarts = vi
      .mocked(callbacks.sendMessage)
      .mock.calls.filter(([, , message]) => message.includes("[first run]"));
    expect(kickstarts).toHaveLength(1);
  });

  it("gives two racing opens one session and one kickstart", async () => {
    // The create-time open and the first routed message used to race: two
    // sessions minted, two introductions delivered.
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const [first, second] = await Promise.all([
      service.openChat(bot.id),
      service.openChat(bot.id),
    ]);

    expect(first.sessionId).toBe(second.sessionId);
    expect(callbacks.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("moves a bot pinned elsewhere into the bot folder", async () => {
    // Bots work in one place. A bot pinned to a project workspace by an
    // earlier build does not keep its chat there — it gets one in the bot
    // folder the next time it is opened. The old transcript stays in that
    // workspace's session list; the bot just stops pointing at it.
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });
    await service.openChat(bot.id);

    recordBotSession(bot.id, "ws-someone-elses-project", "session-old");

    const handle = await service.openChat(bot.id);

    expect(handle.workspaceId).toBe("ws-default");
    expect(handle.sessionId).not.toBe("session-old");
    expect(getBot(bot.id)?.workspaceId).toBe("ws-default");
  });

  it("keeps the chat it already has in the bot folder", async () => {
    // The move is only for chats that are somewhere else. One already in the
    // bot folder is the bot's conversation and is left alone.
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const first = await service.openChat(bot.id);
    const second = await service.openChat(bot.id);

    expect(second.workspaceId).toBe("ws-default");
    expect(second.sessionId).toBe(first.sessionId);
  });

  it("fails closed on an unknown bot", async () => {
    const service = new BotService(makeCallbacks());

    await expect(service.openChat("bot-missing")).rejects.toThrow();
  });

  it("still opens the chat when the session fails to start", async () => {
    const callbacks = makeCallbacks({
      startSession: vi.fn().mockResolvedValue({ success: false }),
    });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const handle = await service.openChat(bot.id);

    expect(handle.sessionId).toBe("session-1");
    expect(callbacks.sendMessage).not.toHaveBeenCalled();
  });
});

describe("a lost registry row", () => {
  it("recovers the conversation by its owner stamp instead of minting twins", async () => {
    // The field case: two app instances raced the sender registry, the
    // sender chat's row was never written, and the next open minted a
    // duplicate. With parentage stamped on the session itself, the original
    // is found even with the registry empty.
    const owners = new Map<
      string,
      {
        workspaceId: string;
        sessionId: string;
        role: string;
        key: string | null;
      }
    >();
    let counter = 0;
    const callbacks = makeCallbacks({
      createSession: (workspaceId, owner) => {
        const id = `session-${++counter}`;
        owners.set(`${owner.botId}|${owner.role}|${owner.key}`, {
          workspaceId,
          sessionId: id,
          role: owner.role,
          key: owner.key,
        });
        return { id };
      },
      findOwnedSession: (botId, role, key) => {
        const found = owners.get(`${botId}|${role}|${key}`);
        return found == null
          ? null
          : { workspaceId: found.workspaceId, sessionId: found.sessionId };
      },
    });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const first = await service.openSenderChat(bot.id, "whatsapp", "c1", "Ma");
    // The registry loses the row (a wipe, an instance race)…
    removeSenderSession(senderSessionKey(bot.id, "whatsapp", "c1"));

    const second = await service.openSenderChat(bot.id, "whatsapp", "c1", "Ma");

    expect(second.sessionId).toBe(first.sessionId);
    // …and the registry has re-learned it.
    expect(
      getSenderSession(senderSessionKey(bot.id, "whatsapp", "c1"))?.sessionId
    ).toBe(first.sessionId);
  });
});

describe("deleting a bot", () => {
  it("removes its chat with it", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });
    await service.openChat(bot.id);

    service.delete(bot.id);

    expect(callbacks.removeSession).toHaveBeenCalledWith(
      "ws-default",
      "session-1"
    );
    expect(getBot(bot.id)).toBeNull();
  });
});

describe("the bot's model", () => {
  it("pins the chat's session to the bot's model on open", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "Scout",
      description: "Watch.",
      model: "deepseek/deepseek-v4-flash",
    });

    await service.openChat(bot.id);

    expect(callbacks.updateSessionModel).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      "deepseek/deepseek-v4-flash"
    );
  });

  it("puts a bot with no model of its own on the app's default", async () => {
    // "Default" in the bot dialog has to mean the same model the session
    // pickers show. Left unpinned, the chat started on the CLI's own fallback
    // instead, so a bot quietly ran on a different model from everything else.
    const callbacks = makeCallbacks({ defaultModel: () => "abacus/route-llm" });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    expect(callbacks.updateSessionModel).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      "abacus/route-llm"
    );
  });

  it("pins nothing when the app has no default stored yet", async () => {
    const callbacks = makeCallbacks({ defaultModel: () => null });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    expect(callbacks.updateSessionModel).not.toHaveBeenCalled();
  });

  it("prefers the bot's own model over the app default", async () => {
    const callbacks = makeCallbacks({ defaultModel: () => "abacus/route-llm" });
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "Scout",
      description: "Watch.",
      model: "openllm/auto",
    });

    await service.openChat(bot.id);

    expect(callbacks.updateSessionModel).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      "openllm/auto"
    );
  });

  it("repoints a live chat when the bot's model is edited", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });
    await service.openChat(bot.id);

    service.update(bot.id, { model: "openllm/auto" });

    expect(callbacks.updateSessionModel).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      "openllm/auto"
    );
  });
});

describe("an edit the bot should hear about", () => {
  it("tells the bot's chat what changed, once it has one", async () => {
    const sendMessage = vi.fn();
    const service = new BotService(makeCallbacks({ sendMessage }));
    const bot = service.create({ name: "Scout", description: "Watch." });
    await service.openChat(bot.id);
    sendMessage.mockClear();

    await service.announceChange(bot.id, {
      mission: true,
      checkIn: "weekdays at 09:00",
    });

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const text = String(sendMessage.mock.calls[0]?.[2]);
    expect(text).toContain("[mission updated]");
    expect(text).toContain("your mission");
    expect(text).toContain("weekdays at 09:00");
    expect(text).toContain("do not carry out your mission now");
  });

  it("says nothing to a bot that has never had a chat, or about nothing", async () => {
    const sendMessage = vi.fn();
    const service = new BotService(makeCallbacks({ sendMessage }));
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.announceChange(bot.id, { mission: true });
    await service.openChat(bot.id);
    sendMessage.mockClear();
    await service.announceChange(bot.id, {});

    expect(sendMessage).not.toHaveBeenCalled();
  });
});

describe("the persona", () => {
  it("tells a bot that a scheduled mission is a routine to create", () => {
    const service = new BotService(makeCallbacks());
    const bot = service.create({
      name: "Email Drafting",
      description: "Every day at 10 am, draft replies to unread mail.",
    });

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");

    expect(persona).toContain("create it with the cronjob tool");
    expect(persona).toContain("not a promise");
  });
});

describe("the persona env", () => {
  it("points a bot's session at its persona file, and only a bot's", async () => {
    const service = new BotService(makeCallbacks());
    const bot = service.create({ name: "Scout", description: "Watch." });
    const handle = await service.openChat(bot.id);

    expect(service.personaEnvForSession(handle.sessionId)).toEqual({
      ABACUSAI_BOT_PERSONA: personaPath(bot.id),
      ABACUSAI_BOT_BOT_DIR: path.dirname(personaPath(bot.id)),
    });
    expect(service.personaEnvForSession("session-unrelated")).toEqual({});
  });
});

describe("where a bot's chat goes", () => {
  it("waits for a workspace that has to be created first", async () => {
    // A first run has no workspace at all, and the bot maker is the screen it
    // opens on — so resolving one is allowed to be async. Returning the
    // promise itself would have made the workspace id the string "[object
    // Promise]" and every bot chat land in a folder that does not exist.
    const service = new BotService(
      makeCallbacks({
        resolveDefaultWorkspaceId: () => Promise.resolve("ws-made-just-now"),
        isWorkspaceUsable: (id) => id === "ws-made-just-now",
        sessionExists: () => false,
      })
    );
    const bot = service.create({ name: "Scout", description: "Look around" });

    const handle = await service.openChat(bot.id);

    expect(handle.workspaceId).toBe("ws-made-just-now");
  });

  it("still refuses when there is nowhere at all", async () => {
    const service = new BotService(
      makeCallbacks({
        resolveDefaultWorkspaceId: () => null,
        isWorkspaceUsable: () => false,
        sessionExists: () => false,
      })
    );
    const bot = service.create({ name: "Scout", description: "Look around" });

    await expect(service.openChat(bot.id)).rejects.toThrow(/No workspace/);
  });
});
