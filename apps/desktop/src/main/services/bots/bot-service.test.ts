import fs from "fs";
import os from "os";
import path from "path";

import { GOAL_MISSION } from "@abacus-ai/contract/bots/check-in";
import { BOT_TEMPLATES } from "@abacus-ai/contract/bots/templates";
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
    effectiveModel: (requested) => requested,
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
    expect(persona).toContain("**Your mission, yours alone:** Watch the news.");
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

  it("tells a chat-app agent its home", () => {
    // A Telegram Agent with only WhatsApp linked introduced itself by
    // offering to send WhatsApp messages and never asked for Telegram.
    const service = new BotService(makeCallbacks());

    const bot = service.create({
      name: "Telegram Agent",
      description: "Live in my Telegram.",
      homeChannel: "telegram",
    });

    expect(bot.homeChannel).toBe("telegram");
    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain("**Your main connector to use is Telegram.**");
    expect(persona).toContain(
      "**The one account your mission needs:** Telegram."
    );
  });

  it("names what the mission needs, home app first, and never says offer", () => {
    // Told to offer, new bots greeted with "tap the Connect card" and never
    // called the tool, so no card was there.
    const service = new BotService(makeCallbacks());

    const bot = service.create({
      name: "Follow-Up",
      description: "Chase replies.",
      homeChannel: "whatsapp",
      templateId: "follow-up-tracker",
    });

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    // Its home app is the one account; a mission the user rewrote keeps the
    // template's other accounts as ones that only make the work better.
    expect(persona).toContain(
      "**The one account your mission needs:** WhatsApp."
    );
    expect(persona).toContain(
      "**Accounts that make your work better:** Gmail, Slack, Google Calendar."
    );
    expect(persona).toContain("call connect_connector for it right away");
    expect(persona).toContain(
      "Never say a Connect card, link or QR code is waiting unless you"
    );
    expect(persona).not.toMatch(/offer to connect/);
  });

  it("remembers the template it was made from, and a written bot none", () => {
    const service = new BotService(makeCallbacks());

    const made = service.create({
      name: "Email Drafting",
      description: "Draft replies.",
      templateId: "email-drafting",
    });
    const written = service.create({ name: "Scout", description: "Watch." });

    expect(getBot(made.id)?.templateId).toBe("email-drafting");
    expect(getBot(written.id)?.templateId).toBeUndefined();
  });

  it("drops a template's role once the user rewrote its mission, and keeps it while unchanged", () => {
    const service = new BotService(makeCallbacks());
    const chief = BOT_TEMPLATES.find((row) => row.id === "chief-of-staff")!;

    const kept = service.create({
      name: "Chief of Staff",
      title: chief.title,
      description: chief.mission,
      templateId: chief.id,
    });
    const renamed = service.create({
      name: "Site Pal",
      title: chief.title,
      description: "Build my portfolio site.",
      templateId: chief.id,
    });
    // Made from the template before bots remembered it.
    const older = service.create({
      name: "Coder",
      title: chief.title,
      description: "Help me write Kaggle notebooks.",
    });

    expect(fs.readFileSync(personaPath(kept.id), "utf8")).toContain(
      "**Role:** Chief of Staff"
    );
    for (const bot of [renamed, older]) {
      // Its own part; the colleague list below names the bot called "Chief of Staff".
      const [persona, colleagues] = fs
        .readFileSync(personaPath(bot.id), "utf8")
        .split("**Your fellow bots.**");
      expect(persona).not.toContain("Chief of Staff");
      expect(persona).not.toContain("**Role:**");
      // Nor does a colleague keep a stale template role.
      expect(colleagues).not.toMatch(/(Site Pal|Coder) \(Chief of Staff\)/);
    }
  });

  it("gives a bot with no home app no home line", () => {
    const service = new BotService(makeCallbacks());

    const bot = service.create({ name: "Scout", description: "Watch." });

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).not.toContain("Your main connector to use is");
    expect(persona).not.toMatch(
      /account your mission needs|Accounts that make/
    );
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
      expect.stringContaining("[first run]"),
      { operator: { kind: "kickstart" } }
    );
    // The kickstart is the user message every tool round keeps answering, so
    // it has to say the greeting is a one-off itself.
    expect(callbacks.sendMessage).toHaveBeenCalledWith(
      "ws-default",
      "session-1",
      expect.stringContaining("No second greeting"),
      { operator: { kind: "kickstart" } }
    );
  });

  it("opened to hand it a task, a new bot gets the task and no first-run kickstart", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    const handle = await service.openChat(bot.id, { forTask: true });

    expect(handle.sessionId).toBe("session-1");
    expect(callbacks.sendMessage).not.toHaveBeenCalled();
    // Kickstarted for good: it does not introduce itself later, mid-work.
    expect(getBot(bot.id)?.kickstartedAt).not.toBeNull();
    await service.openChat(bot.id);
    expect(callbacks.sendMessage).not.toHaveBeenCalled();
  });

  it("has a chat-app agent ask for its unlinked home app before greeting", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "WhatsApp Agent",
      description: "Live in my WhatsApp.",
      homeChannel: "whatsapp",
    });

    await service.openChat(bot.id);

    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toMatch(/^\[first run\] First, if the system reminder/);
    expect(kickstart).toContain(
      "does not list WhatsApp as connected, call connect_connector for it now."
    );
  });

  it("asks a written bot for nothing up front, whatever its mission names", async () => {
    // Only a template declares what a mission needs; a bot the user wrote
    // connects what a task needs when the task comes up.
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "Site Builder",
      description: "Build my website; email me in Gmail when it is live.",
    });

    await service.openChat(bot.id);

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).not.toMatch(
      /account your mission needs|Accounts that make/
    );
    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).not.toContain("connect_connector");
  });

  it("writes the first-run note itself in the app's language", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "pt-BR" });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toBe(
      "[first run] Apresente-se uma única vez e depois comece sua missão. " +
        "Tudo o que vem depois de um resultado de ferramenta é a mesma resposta continuando. " +
        "Sem segunda saudação, sem repetir a missão. " +
        "Escreva em português, o idioma do usuário, a menos que ele escreva para você em outro."
    );
  });

  it("keeps the English note, word for word, for an English app", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "en-US" });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toBe(
      "[first run] Introduce yourself once, then get started on your mission. " +
        "Everything after a tool result is the same reply continuing. No second greeting, " +
        "no restating the mission. Write in American English, the user's language, unless " +
        "they write to you in another."
    );
  });

  it("writes the first run in the reply language's resolver: the saved language first, never Hindi from the device", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "hi-IN" });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);
    const [, , hindiOs] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(hindiOs).toMatch(/^\[first run\] Introduce yourself once/);
    expect(hindiOs).toContain("Write in English, the user's language,");
    expect(hindiOs).not.toMatch(/Hindi|[\u0900-\u097f]/);

    fs.writeFileSync(
      path.join(home, "user-language.json"),
      JSON.stringify({
        language: { name: "Spanish", source: "detected" },
        version: 2,
      })
    );
    const other = service.create({ name: "Scout 2", description: "Watch." });
    await service.openChat(other.id);
    const [, , saved] = vi.mocked(callbacks.sendMessage).mock.calls[1]!;
    expect(saved).toMatch(/^\[first run\] Preséntate una sola vez/);
    expect(saved).toContain(
      "Escribe en español latinoamericano, el idioma del usuario"
    );

    // A language the app has no locale for: the English note, naming it.
    fs.writeFileSync(
      path.join(home, "user-language.json"),
      JSON.stringify({
        language: { name: "Bangla", source: "detected" },
        version: 2,
      })
    );
    const third = service.create({ name: "Scout 3", description: "Watch." });
    await service.openChat(third.id);
    const [, , bangla] = vi.mocked(callbacks.sendMessage).mock.calls[2]!;
    expect(bangla).toContain("Write in Bangla, the user's language,");
  });

  it("starts a bot made from the user's words on those words, asking for nothing", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "tr-TR" });
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "My Assistant",
      description: GOAL_MISSION("Study Buddy for my exams"),
    });

    await service.openChat(bot.id);

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain(
      '**Your mission, yours alone:** The user created you for this, in their own words: "Study Buddy for my exams".'
    );
    expect(persona).not.toMatch(
      /account your mission needs|Accounts that make/
    );
    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toContain(
      'kullanıcının istediği şeye doğru ilk adımı at: "Study Buddy for my exams".'
    );
    expect(kickstart).toContain("Kullanıcının dili olan Türkçe ile yaz;");
    expect(kickstart).not.toContain("connect_connector");
  });

  it("answers a goal typed in another language in that language, from the first reply", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "en-US" });
    const service = new BotService(callbacks);
    const bot = service.create({
      name: "My Assistant",
      description: GOAL_MISSION(
        "Viết giúp tôi một đoạn mã quản lý danh sách khách hàng"
      ),
    });

    await service.openChat(bot.id);

    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toContain(
      "Write in Vietnamese, the user's language, unless they write to you in another."
    );
    expect(
      JSON.parse(fs.readFileSync(path.join(home, "user-language.json"), "utf8"))
    ).toMatchObject({ language: { name: "Vietnamese", source: "detected" } });
  });

  it("names Chinese by its script in the first-run note", async () => {
    const note = async (tag: string): Promise<string> => {
      const callbacks = makeCallbacks({ appLanguage: () => tag });
      const service = new BotService(callbacks);
      const bot = service.create({
        name: "My Assistant",
        description: GOAL_MISSION("Study Buddy for my exams"),
      });
      await service.openChat(bot.id);
      return vi.mocked(callbacks.sendMessage).mock.calls[0]![2];
    };

    expect(await note("zh-HK")).toContain("繁體中文");
    expect(await note("zh-CN")).toContain("简体中文");
  });

  it("kicks off a bot that needs nothing without a connect step", async () => {
    const callbacks = makeCallbacks();
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).not.toContain("connect_connector");
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
    // The session store lost across a relaunch remints the chat, but it is
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
    // earlier build does not keep its chat there. It gets one in the bot
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
    const callbacks = makeCallbacks({
      effectiveModel: (requested) => requested ?? "abacus/route-llm",
    });
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
    const callbacks = makeCallbacks({
      effectiveModel: (requested) => requested,
    });
    const service = new BotService(callbacks);
    const bot = service.create({ name: "Scout", description: "Watch." });

    await service.openChat(bot.id);

    expect(callbacks.updateSessionModel).not.toHaveBeenCalled();
  });

  it("prefers the bot's own model over the app default", async () => {
    const callbacks = makeCallbacks({
      effectiveModel: (requested) => requested ?? "abacus/route-llm",
    });
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
    await service.settled();

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
    expect(sendMessage.mock.calls[0]?.[3]).toEqual({
      operator: { kind: "mission-updated" },
    });
    expect(text).toContain("[mission updated]");
    expect(text).toContain("your mission");
    expect(text).toContain("weekdays at 09:00");
    expect(text).toContain("do not carry out your mission now");
  });

  it("tells the bot what is already scheduled, and that an edit moves it", async () => {
    const sendMessage = vi.fn();
    const service = new BotService(
      makeCallbacks({
        sendMessage,
        botRoutines: () => [
          {
            id: "routine-1",
            name: "Scout check-in",
            when: "0 * * * *",
            checkIn: true,
          },
          { id: "job-1", name: "Inbox", when: "0 8 * * *", checkIn: false },
        ],
      })
    );
    const bot = service.create({ name: "Scout", description: "Watch." });
    await service.openChat(bot.id);
    sendMessage.mockClear();
    expect(service.missionJustEdited(bot.id)).toBe(false);

    await service.announceChange(bot.id, { checkIn: "every hour" });

    const text = String(sendMessage.mock.calls[0]?.[2]);
    expect(text).toContain("the app has saved the check-in schedule itself");
    expect(text).toContain(
      "routine-1  0 * * * *  Scout check-in (your check-in"
    );
    expect(text).toContain('use cronjob "update" with its id');
    expect(service.missionJustEdited(bot.id)).toBe(true);
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

    expect(persona).toContain("Create it with\nthe cronjob tool");
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
    // opens on, so resolving one is allowed to be async. Returning the
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

describe("a sponsored first run", () => {
  it("marks the bot's sessions on the house until its window passes, and no other bot's", () => {
    const service = new BotService(makeCallbacks());
    const sponsored = service.create({
      name: "Chief of Staff",
      description: "Draft my replies.",
      sponsoredFirstRun: true,
    });
    const plain = service.create({
      name: "Plain",
      description: "Nothing free.",
    });
    recordBotSession(sponsored.id, "ws", "s-sponsored");
    recordBotSession(plain.id, "ws", "s-plain");

    expect(service.personaEnvForSession("s-sponsored")).toMatchObject({
      ABACUSAI_BOT_SPONSORED_RUN: "cos-first-run",
    });
    expect(service.personaEnvForSession("s-plain")).not.toHaveProperty(
      "ABACUSAI_BOT_SPONSORED_RUN"
    );
    expect(service.sponsoredRunEnvForBot(sponsored.id)).toEqual({
      ABACUSAI_BOT_SPONSORED_RUN: "cos-first-run",
      ABACUSAI_BOT_SPONSORED_UNTIL: String(sponsored.sponsoredUntil),
    });
    expect(service.sponsoredRunEnvForBot(plain.id)).toEqual({});

    vi.useFakeTimers();
    try {
      vi.setSystemTime((sponsored.sponsoredUntil ?? 0) + 1);
      expect(service.personaEnvForSession("s-sponsored")).not.toHaveProperty(
        "ABACUSAI_BOT_SPONSORED_RUN"
      );
      expect(service.sponsoredRunEnvForBot(sponsored.id)).toEqual({});
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("accessory persistence through the service", () => {
  it("passes accessories to the store and keeps legacy edits working", () => {
    const service = new BotService(makeCallbacks());
    const old = service.create({ name: "Old", description: "Counts" });
    expect(old.avatarAccessory).toBe("none");
    expect(service.update(old.id, { title: "Counter" }).avatarAccessory).toBe(
      "none"
    );
    const bot = service.create({
      name: "Ada",
      description: "Counts",
      avatarAccessory: "monocle",
    });
    expect(
      service.list().find((row) => row.id === bot.id)?.avatarAccessory
    ).toBe("monocle");
    service.update(bot.id, { avatarAccessory: "cap" });
    expect(getBot(bot.id)?.avatarAccessory).toBe("cap");
    service.update(bot.id, { title: "Counter" });
    expect(getBot(bot.id)?.avatarAccessory).toBe("cap");
    service.update(bot.id, { avatarAccessory: null });
    expect(getBot(bot.id)?.avatarAccessory).toBe("none");
  });
});

/**
 * Each chat app's own chat goes to one home bot. The pointer is the
 * service's to keep (here, in memory); setHomeBot is the only writer.
 */
describe("a chat app's home bot", () => {
  const homeService = (): {
    service: BotService;
    stored: Partial<Record<"whatsapp" | "telegram" | "discord", string>>;
    saves: string[];
  } => {
    const stored: Partial<Record<"whatsapp" | "telegram" | "discord", string>> =
      {};
    const saves: string[] = [];
    const service = new BotService(
      makeCallbacks({
        homeBots: () => ({ ...stored }),
        saveHomeBot: (app, botId) => {
          stored[app] = botId;
          saves.push(`${app}:${botId}`);
        },
      })
    );
    return { service, stored, saves };
  };

  it("is the first bot made from the app's agent template, never a later one", () => {
    const { service } = homeService();
    const first = service.create({
      name: "Telegram Agent",
      description: "Live in my Telegram.",
      homeChannel: "telegram",
    });
    service.create({
      name: "Telegram Agent 2",
      description: "Live in my Telegram too.",
      homeChannel: "telegram",
    });

    expect(service.ensureHomeBot("telegram")).toBe(first.id);
    // Creating more bots afterwards moves nothing.
    service.create({
      name: "Telegram Agent 3",
      description: "And me.",
      homeChannel: "telegram",
    });
    expect(service.ensureHomeBot("telegram")).toBe(first.id);
  });

  it("is made from the template when no bot was", () => {
    const { service, stored } = homeService();

    const id = service.ensureHomeBot("discord");

    const bot = getBot(id)!;
    expect(bot.name).toBe("Discord Agent");
    expect(bot.homeChannel).toBe("discord");
    expect(stored.discord).toBe(id);
  });

  it("falls back to the template rule once the home bot is deleted", () => {
    const { service } = homeService();
    const chosen = service.create({
      name: "Price Watch",
      description: "Trade.",
    });
    service.setHomeBot("telegram", chosen.id);
    const agent = service.create({
      name: "Telegram Agent",
      description: "Live in my Telegram.",
      homeChannel: "telegram",
    });

    service.delete(chosen.id);

    expect(service.homeBotId("telegram")).toBeNull();
    expect(service.ensureHomeBot("telegram")).toBe(agent.id);
    service.delete(agent.id);
    // Nothing left from the template: a new one is made.
    const remade = service.ensureHomeBot("telegram");
    expect(getBot(remade)?.name).toBe("Telegram Agent");
  });

  it("changes only through setHomeBot, which refuses a bot that does not exist", () => {
    const { service, saves } = homeService();
    const bot = service.create({ name: "Scout", description: "Watch." });

    service.setHomeBot("whatsapp", bot.id);
    service.setHomeBot("whatsapp", bot.id);

    expect(saves).toEqual([`whatsapp:${bot.id}`]);
    expect(() => service.setHomeBot("whatsapp", "bot-gone")).toThrow(/No bot/);
  });

  it("tells the home bot the chat is its own, and only the others where it goes", () => {
    const { service } = homeService();
    const home = service.create({
      name: "Telegram Agent",
      description: "Live.",
    });
    const other = service.create({ name: "Scout", description: "Watch." });

    service.setHomeBot("telegram", home.id);

    const homePersona = fs.readFileSync(personaPath(home.id), "utf8");
    const otherPersona = fs.readFileSync(personaPath(other.id), "utf8");
    expect(homePersona).toContain("The user's own Telegram chat comes to you");
    expect(homePersona).not.toContain("currently go to");
    expect(otherPersona).toContain(
      "say their Telegram messages\ncurrently go to Telegram Agent"
    );
    expect(otherPersona).toContain("take_chat_app_messages");
    // No line for an app with no home bot.
    expect(otherPersona).not.toContain("WhatsApp messages");

    // Switching rewrites both sides.
    service.setHomeBot("telegram", other.id);
    expect(fs.readFileSync(personaPath(home.id), "utf8")).toContain(
      "currently go to Scout"
    );
  });
});

describe("an older install's self-lane bot", () => {
  it("is adopted once as the app's agent and home bot, history kept", () => {
    const stored: Partial<Record<"whatsapp" | "telegram" | "discord", string>> =
      {};
    const service = new BotService(
      makeCallbacks({
        homeBots: () => ({ ...stored }),
        saveHomeBot: (app, botId) => {
          stored[app] = botId;
        },
      })
    );
    const legacy = service.create({
      name: "Telegram AbacusAI Bot <-> You",
      description: "You are the user's personal assistant.",
      channel: "telegram",
    });
    recordBotSession(legacy.id, "ws-default", "session-old");

    service.adoptChannelBots();

    const adopted = getBot(legacy.id)!;
    expect(adopted.name).toBe("Telegram Agent");
    expect(adopted.title).toBe("Your agent in Telegram - message it anytime");
    expect(adopted.description).toContain("Live in my Telegram.");
    expect(adopted.homeChannel).toBe("telegram");
    expect(adopted.channel).toBeNull();
    expect(adopted.sessionId).toBe("session-old");
    expect(stored.telegram).toBe(legacy.id);

    // A second launch finds nothing to adopt and changes nothing.
    service.update(legacy.id, { name: "My Telegram" });
    service.adoptChannelBots();
    expect(getBot(legacy.id)?.name).toBe("My Telegram");
  });

  it("keeps a home bot the app already has", () => {
    const stored: Partial<Record<"whatsapp" | "telegram" | "discord", string>> =
      {};
    const service = new BotService(
      makeCallbacks({
        homeBots: () => ({ ...stored }),
        saveHomeBot: (app, botId) => {
          stored[app] = botId;
        },
      })
    );
    const chosen = service.create({ name: "Scout", description: "Watch." });
    stored.whatsapp = chosen.id;
    service.create({
      name: "WhatsApp AbacusAI Bot <-> You",
      description: "Legacy.",
      channel: "whatsapp",
    });

    service.adoptChannelBots();

    expect(stored.whatsapp).toBe(chosen.id);
  });
});

describe("a template bot's accounts", () => {
  const fromTemplate = (service: BotService, id: string, mission?: string) => {
    const template = BOT_TEMPLATES.find((row) => row.id === id)!;
    return service.create({
      name: template.name,
      title: template.title,
      persona: template.persona,
      description: mission ?? template.mission,
      templateId: template.id,
    });
  };

  it("hands over a result first when no account is required, then offers one", async () => {
    // Asking for three accounts in one link before anything useful lost the user.
    const callbacks = makeCallbacks({ appLanguage: () => "en-US" });
    const service = new BotService(callbacks);
    const bot = fromTemplate(service, "personal-admin");

    await service.openChat(bot.id);

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).not.toContain("account your mission needs");
    expect(persona).toContain(
      "**Accounts that make your work better:** Gmail, Google Calendar, Google Drive."
    );
    expect(persona).toContain(
      "Until one is connected: Brief me each weekday from the web: the weather where I am"
    );
    expect(persona).toContain("may offer one of them");
    expect(persona).toContain("never several at once");
    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toMatch(
      /^\[first run\] First hand over a real result made with what works without any account, or, when the job starts from something only the user can give/
    );
    expect(kickstart).not.toContain("call connect_connector");
  });

  it("asks at once for the one account a job cannot start without", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "en-US" });
    const service = new BotService(callbacks);
    const bot = fromTemplate(service, "chief-of-staff");

    await service.openChat(bot.id);

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain("**The one account your mission needs:** Gmail.");
    expect(persona).toContain(
      "hand\nover a short sample of what you will deliver"
    );
    expect(persona).not.toContain("Accounts that make");
    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).toContain(
      "does not list Gmail as connected, call connect_connector for it now."
    );
  });

  it("only offers a required account once the user rewrote the mission", async () => {
    const callbacks = makeCallbacks({ appLanguage: () => "en-US" });
    const service = new BotService(callbacks);
    const bot = fromTemplate(
      service,
      "chief-of-staff",
      "Keep me on top of my week."
    );

    await service.openChat(bot.id);

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).not.toContain("account your mission needs");
    expect(persona).toContain(
      "**Accounts that make your work better:** Gmail."
    );
    // The template's play for an empty account is for its own mission only.
    expect(persona).not.toContain("Until one is connected");
    const [, , kickstart] = vi.mocked(callbacks.sendMessage).mock.calls[0]!;
    expect(kickstart).not.toContain("call connect_connector");
  });

  it("tells every bot where the computer says the user is", () => {
    const service = new BotService(
      makeCallbacks({
        computerRegion: () => "Europe/London time zone, United Kingdom",
      })
    );
    const bot = fromTemplate(service, "morning-brief");

    const persona = fs.readFileSync(personaPath(bot.id), "utf8");
    expect(persona).toContain(
      "**Where the user is:** this computer is set to Europe/London time zone, United Kingdom."
    );
    expect(persona).toContain("weather, local news and local times");
  });
});
