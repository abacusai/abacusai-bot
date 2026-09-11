/**
 * A bot chat must see a tool its MCP server gained mid-conversation — the
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

import type { DesktopEvent } from "../protocol.js";
import { BotSession } from "./bot-session.js";

let provider: FakeProvider;
let home: string;
let botDir: string;
let configPath: string;
let server: FakeMcpServer | null = null;
let bot: BotSession | null = null;

const offeredTools = (): string[] => provider.calls.at(-1)?.tools ?? [];

const systemPrompt = (): string => {
  const message = provider.calls
    .at(-1)
    ?.messages.find((entry) => entry.role === "system");
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
  process.env.PI_OFFLINE = "1";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
});

afterEach(async () => {
  bot?.dispose();
  bot = null;
  await server?.close();
  server = null;
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

describe("a bot chat whose connector gateway gains a tool", () => {
  it("offers the tool on the next turn, and says so in its prompt", async () => {
    // The gateway is up with nothing behind it — no connector yet.
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
    await bot.send("send hi to sreemanti on slack dm");

    expect(offeredTools()).toContain("abacus-connectors_Slack_Tool");
    expect(systemPrompt()).toMatch(/`abacus-connectors` \(1 tool/);
  }, 60_000);

  it("continues the turn with a tool that landed while the turn ran", async () => {
    // Slack connected from inside the chat: connect_connector returns, the
    // gateway gains the tool, and every session is refreshed a moment later
    // — after the tool result, inside the same turn. pi's tool list is fixed
    // for the turn, so the model's follow-up request cannot see the tool;
    // it said "cannot send hi to sreemanti on DM". The turn is continued
    // once it ends, with the arrival named, and that request has the tool.
    let refreshed: Promise<void> = Promise.resolve();
    server = await FakeMcpServer.start([
      {
        name: "connect",
        reply: () => {
          server!.setTools([
            { name: "connect", reply: () => "connected" },
            { name: "Slack_Tool", reply: () => "sent" },
          ]);
          refreshed = new Promise((resolve) => {
            setTimeout(() => void bot!.refreshMcp().then(resolve), 0);
          });
          return "Slack is connected.";
        },
      },
    ]);
    fs.writeFileSync(
      configPath,
      mcpConfig({ "abacus-connectors": { url: server.url } }),
      "utf8"
    );
    bot = newBot();
    await bot.start();
    // The refresh in the field landed six seconds before the turn ended;
    // here the follow-up request waits for it, so the ordering is the same.
    provider.script(async (_call, index) => {
      if (index === 0)
        return { call: { name: "abacus-connectors_connect", args: {} } };
      if (index === 1) {
        await refreshed;
        return { say: "I cannot send that — no Slack tool here." };
      }
      return { say: "sent" };
    });
    await bot.send("connect slack and dm sreemanti hi");

    // Request 1 is pi's follow-up on the fixed list; request 2 is ours.
    expect(provider.calls).toHaveLength(3);
    expect(provider.calls[1]?.tools).not.toContain(
      "abacus-connectors_Slack_Tool"
    );
    expect(provider.calls[2]?.tools).toContain("abacus-connectors_Slack_Tool");
    expect(provider.calls[2]?.userText.join("\n")).toMatch(
      /became available: abacus-connectors_Slack_Tool/
    );
  }, 60_000);
});
