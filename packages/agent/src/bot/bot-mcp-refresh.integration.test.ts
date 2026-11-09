/**
 * A bot chat must see a tool its MCP server gained mid-conversation: the
 * Slack connector a user adds from the bot chat itself. The desktop session
 * has this covered; the bot loop is a separate session class and had no
 * proof of its own.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeMcpServer,
  mcpConfig,
} from "@abacus-ai/test-support/fake-mcp-server";
import {
  FakeProvider,
  fakeProviderConfig,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import type { ForeverEngine } from "../forever/engine.js";
import { IDENTITY_PROMPT } from "../persona.js";
import { PhoneSession } from "../phone/phone-session.js";
import type { DesktopEvent } from "../protocol.js";
import { writeUserLanguage } from "../user-language.js";
import { BotSession } from "./bot-session.js";

let provider: FakeProvider;
let home: string;
let botDir: string;
let configPath: string;
let server: FakeMcpServer | null = null;
let bot: ForeverEngine | null = null;

const offeredTools = (): string[] => provider.calls.at(-1)?.tools ?? [];

const systemPrompt = (call = provider.calls.at(-1)): string => {
  const message = call?.messages.find((entry) => entry.role === "system");
  const content = message?.content;
  return typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .map((part) =>
            part != null && typeof part === "object" && "text" in part
              ? String((part as { text: unknown }).text)
              : ""
          )
          .join("")
      : "";
};

const newBot = (): BotSession =>
  new BotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botmcp-")),
    mode: "yolo",
    emit: (_event: DesktopEvent) => {},
  });

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botmcp-home-"));
  botDir = path.join(home, "bots", "bot-1");
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.mkdirSync(botDir, { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    fakeProviderConfig(provider),
    "utf8"
  );
  configPath = path.join(home, "mcp.json");
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
  process.env.ABACUSAI_BOT_MCP_CONFIG = configPath;
  process.env.ABACUSAI_BOT_PHONE_DIR = path.join(home, "phone");
  process.env.PI_OFFLINE = "1";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
  delete process.env.ABACUSAI_BOT_PHONE_DIR;
});

afterEach(async () => {
  bot?.dispose();
  bot = null;
  delete process.env.ABACUSAI_BOT_LOCALE;
  delete process.env.ABACUSAI_BOT_SENDER_CHAT;
  delete process.env.ABACUSAI_BOT_AUDIENCE;
  fs.rmSync(path.join(home, "user-language.json"), { force: true });
  await server?.close();
  server = null;
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("a bot chat whose connector gateway gains a tool", () => {
  it("offers the tool on the next turn, and says so in its prompt", async () => {
    // The gateway is up with nothing behind it: no connector yet.
    server = await FakeMcpServer.start([]);
    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );
    bot = newBot();
    await bot.start();
    await bot.send("hi");
    expect(offeredTools()).not.toContain("abacus-connectors_Slack_Tool");

    // Slack connected between turns: the gateway carries its tool and the
    // session is told to refresh.
    server.setTools([{ name: "Slack_Tool", reply: () => "sent" }]);
    await bot.refreshMcp();
    await bot.send("send hi to alex on slack dm");

    expect(offeredTools()).toContain("abacus-connectors_Slack_Tool");
    expect(systemPrompt()).toMatch(
      /`abacus-connectors` \(tools named `abacus-connectors_\*`\)/
    );

    // Slack disconnected: the gateway drops its tool, and so does the chat.
    server.setTools([]);
    await bot.refreshMcp();
    await bot.send("send hi again");
    expect(offeredTools()).not.toContain("abacus-connectors_Slack_Tool");
  }, 60_000);

  it("never changes the tools under a running run: a refresh landing mid-turn applies at the turn's end, which continues with the new tools", async () => {
    // A refresh landing inside a turn (one main gave up waiting on, or a
    // server coming up late): the gateway gains Slack and drops Calendar
    // after the tool result. The run in flight keeps the tools it started
    // with; at the turn's end the change applies and the turn continues
    // once, naming Slack.
    let refreshed: Promise<void> = Promise.resolve();
    // The gateway only offers registry tools, so the trigger is one of them:
    // a Gmail call whose side effect is the gateway's tools changing.
    server = await FakeMcpServer.start([
      {
        name: "Gmail_Tool",
        reply: () => {
          server!.setTools([
            { name: "Gmail_Tool", reply: () => "connected" },
            { name: "Slack_Tool", reply: () => "sent" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(() => void bot!.refreshMcp().then(resolve), 0);
          });
          return "Slack is connected.";
        },
      },
      { name: "Google_Calendar_Tool", reply: () => "events" },
    ]);
    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );
    bot = newBot();
    await bot.start();
    // The follow-up request waits for the refresh, so it lands mid-turn.
    provider.script(async (_call, index) => {
      if (index === 0)
        return { call: { name: "abacus-connectors_Gmail_Tool", args: {} } };
      if (index === 1) {
        await refreshed;
        return { say: "I cannot send that: no Slack tool here." };
      }
      return { say: "sent" };
    });
    await bot.send("connect slack and dm hi");

    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.tools).toContain(
      "abacus-connectors_Google_Calendar_Tool"
    );
    expect(provider.calls[1]?.tools).not.toContain(
      "abacus-connectors_Slack_Tool"
    );
    expect(provider.calls[2]?.tools).toContain("abacus-connectors_Slack_Tool");
    expect(provider.calls[2]?.tools).not.toContain(
      "abacus-connectors_Google_Calendar_Tool"
    );
    expect(provider.calls[2]?.userText.join("\n")).toMatch(
      /became available: abacus-connectors_Slack_Tool/
    );
  }, 60_000);
});

describe.each([
  {
    engine: "a bot chat",
    create: (cwd: string): ForeverEngine =>
      new BotSession({ cwd, mode: "yolo", emit: () => {} }),
    marker: "persistent personal bot with one long-running conversation",
  },
  {
    engine: "the phone loop",
    create: (cwd: string): ForeverEngine =>
      new PhoneSession({ cwd, mode: "yolo", emit: () => {} }),
    marker: "personal assistant on WhatsApp",
  },
])("$engine, after a roster-change reload", ({ create, marker }) => {
  it("takes a tool added mid-turn into the continuation and the next turn, always under its own prompt", async () => {
    // The production sequence: a connector between turns rebuilds the prompt
    // (a loader reload), then another lands mid-turn. A reload used to move
    // the tool handle to a runtime the session never reads.
    let refreshed: Promise<void> = Promise.resolve();
    server = await FakeMcpServer.start([]);
    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );
    bot = create(
      fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botmcp-"))
    );
    await bot.start();
    await bot.send("one");
    const turnOne = provider.calls.length;

    server.setTools([
      {
        name: "Gmail_Tool",
        reply: () => {
          server!.setTools([
            { name: "Gmail_Tool", reply: () => "connected" },
            { name: "Slack_Tool", reply: () => "sent" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(() => void bot!.refreshMcp().then(resolve), 0);
          });
          return "Slack is connected.";
        },
      },
    ]);
    await bot.refreshMcp();
    provider.script(async (_call, index) => {
      if (index === turnOne)
        return { call: { name: "abacus-connectors_Gmail_Tool", args: {} } };
      if (index === turnOne + 1) {
        await refreshed;
        return { say: "No Slack tool here." };
      }
      return { say: "sent" };
    });
    await bot.send("two");

    const turnTwo = provider.calls.slice(turnOne);
    expect(turnTwo).toHaveLength(3);
    expect(turnTwo[1]?.tools).not.toContain("abacus-connectors_Slack_Tool");
    expect(turnTwo[2]?.userText.join("\n")).toMatch(
      /became available: abacus-connectors_Slack_Tool/
    );
    expect(turnTwo[2]?.tools).toContain("abacus-connectors_Slack_Tool");

    await bot.send("three");
    const turnThree = provider.calls.at(-1)!;
    expect(turnThree.tools).toContain("abacus-connectors_Slack_Tool");
    // Neither a tool-count-only change nor a mid-turn arrival touches the
    // prompt, and so its cache.
    for (const call of [...turnTwo, turnThree])
      expect(systemPrompt(call)).toBe(systemPrompt(turnTwo[0]));

    for (const call of provider.calls) {
      const system = systemPrompt(call);
      expect(system).toContain(IDENTITY_PROMPT.split("\n")[0]);
      expect(system).toContain(marker);
      // The guidelines pi shows only in its own default prompt.
      expect(system).toContain(
        "Use read to examine files instead of cat or sed"
      );
      expect(system).toMatch(/edits\[\]\.oldText must match the file exactly/);
      expect(system).not.toMatch(/inside pi|Pi documentation/);
    }
  }, 60_000);
});

describe("the reply-language block in a bot's chats", () => {
  const BLOCK = "## Reply language";
  const blockLine = (prompt: string): string =>
    prompt.slice(prompt.indexOf(BLOCK)).split("\n")[2] ?? "";
  const prompts = (): string[] =>
    provider.calls.map((call) => systemPrompt(call));

  it("closes the bot's prompt with the app's language, byte-identical across turns in mixed languages", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "es-MX";
    bot = newBot();
    await bot.start();
    for (const text of ["hola", "ok", "what's next?", "merci", "gracias"])
      await bot.send(text);

    const [first, ...rest] = prompts();
    expect(blockLine(first!)).toContain(
      "The user's language is Mexican Spanish."
    );
    expect(blockLine(first!)).toContain("the user's latest message");
    // Once, and after the bot's memory: last of what the app contributes.
    expect(first!.split(BLOCK)).toHaveLength(2);
    expect(first!.indexOf(BLOCK)).toBeGreaterThan(
      first!.indexOf("persistent personal bot")
    );
    for (const prompt of rest) expect(prompt).toBe(first);
  }, 60_000);

  it("changes once when the language is first saved, and never per message", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "tr-TR";
    bot = newBot();
    await bot.start();
    await bot.send("merhaba");
    writeUserLanguage("Turkish", "detected");
    await bot.send("nasılsın");
    await bot.send("ok");

    const all = prompts();
    expect(new Set(all).size).toBe(1);
    expect(blockLine(all[0]!)).toContain("The user's language is Turkish.");

    writeUserLanguage("German", "user");
    await bot.send("hallo");
    await bot.send("danke");
    const after = prompts().slice(all.length);
    expect(new Set(after).size).toBe(1);
    expect(blockLine(after[0]!)).toContain(
      "The user chose German for every reply"
    );
  }, 60_000);

  it("lets a remote sender's message win in their chat, the user's choice only the fallback", async () => {
    writeUserLanguage("German", "user");
    process.env.ABACUSAI_BOT_SENDER_CHAT = "1";
    bot = newBot();
    await bot.start();
    await bot.send("¿Hola, está disponible mañana?");

    const line = blockLine(systemPrompt());
    expect(line).toMatch(
      /^The person writing to you here is not the user\. Reply in the language of their latest message;/
    );
    expect(line).toContain("reply in German, the user's language.");
    expect(line).not.toContain("The user chose");
  }, 60_000);

  it("gives the phone loop one rule, from its own language, not the app's", async () => {
    process.env.ABACUSAI_BOT_LOCALE = "tr-TR";
    bot = new PhoneSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botmcp-")),
      mode: "yolo",
      emit: () => {},
    });
    await bot.start();
    await bot.send("hi");

    const prompt = systemPrompt();
    expect(prompt).not.toContain(BLOCK);
    expect(
      prompt.match(/Reply in the language of the user's latest message/g)
    ).toHaveLength(1);
    expect(prompt).toContain("The user's language is English.");
    expect(prompt).not.toContain("language is Turkish");
  }, 60_000);

  it("offers set_user_language in the user's own bot chat, and never in a sender's", async () => {
    process.env.ABACUSAI_BOT_AUDIENCE = "owner";
    bot = newBot();
    await bot.start();
    await bot.send("lütfen İngilizce cevap ver");
    expect(offeredTools()).toContain("set_user_language");
    bot.dispose();

    delete process.env.ABACUSAI_BOT_AUDIENCE;
    process.env.ABACUSAI_BOT_SENDER_CHAT = "1";
    bot = newBot();
    await bot.start();
    await bot.send("answer in English please");
    expect(offeredTools()).not.toContain("set_user_language");
  }, 60_000);

  it("lets the phone loop save a language asked for from now on, through its check-ins setting", async () => {
    bot = new PhoneSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-botmcp-")),
      mode: "yolo",
      emit: () => {},
    });
    await bot.start();
    await bot.send("reply in English from now on");
    const tools = (provider.calls.at(-1)?.body.tools ?? []) as Array<{
      function?: { name?: string; description?: string };
    }>;
    const checkins = tools.find((tool) =>
      /check-ins/.test(tool.function?.description ?? "")
    );
    expect(checkins?.function?.description).toMatch(
      /the one they ask every reply\s+in from now on/
    );
  }, 60_000);
});
