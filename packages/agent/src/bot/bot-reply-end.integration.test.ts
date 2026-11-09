/**
 * `suggest_tasks` closes a reply: after a written reply the turn ends with no
 * second request; any other order keeps it running until a reply is written.
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
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { ForeverEngine } from "../forever/engine.js";
import type { AgentEvent, DesktopEvent } from "../protocol.js";
import { BotSession } from "./bot-session.js";

const TASKS = {
  tasks: [{ text: "Plan my week" }, { text: "Draft an email" }],
};
const REPLY = "Hi, I'm your assistant. Tap a task below to start.";
const suggest = { name: "suggest_tasks", args: TASKS };

let provider: FakeProvider;
let server: FakeMcpServer;
let home: string;
let bot: ForeverEngine | null = null;
let events: AgentEvent[] = [];

const said = (): string =>
  events
    .flatMap((event) => (event.type === "text_delta" ? event.content : []))
    .join("");

const toolResultsSent = (index: number): string[] =>
  (provider.calls[index]?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) => JSON.stringify(message.content));

const turn = async (replies: Reply[], text = "hi"): Promise<void> => {
  provider.scriptSequence(replies);
  await bot!.send(text, { messageId: "m1" });
};

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-replyend-"));
  const botDir = path.join(home, "bots", "bot-1");
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
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
  process.env.ABACUSAI_BOT_MCP_CONFIG = path.join(home, "mcp.json");
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

beforeEach(async () => {
  server = await FakeMcpServer.start([
    {
      name: "suggest_tasks",
      inputSchema: {
        type: "object",
        properties: { tasks: { type: "array" } },
        required: ["tasks"],
      },
      reply: () => "The user sees 2 buttons under your reply.",
      refuses: (args) => (args.tasks as unknown[]).length === 0,
    },
    { name: "todo", reply: () => "saved" },
  ]);
  fs.writeFileSync(
    process.env.ABACUSAI_BOT_MCP_CONFIG!,
    mcpConfig({ "agent-tools": { url: server.url, isBuiltin: true } }),
    "utf8"
  );
  events = [];
  bot = new BotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-replyend-cwd-")),
    mode: "yolo",
    emit: (message: DesktopEvent) => {
      if (message.type === "event") events.push(message.event);
    },
  });
  await bot.start();
});

afterEach(async () => {
  bot?.dispose();
  bot = null;
  await server.close();
  provider.calls.length = 0;
});

describe("a bot's suggest_tasks call", () => {
  it("after a written reply ends the turn: one request, one reply, the buttons, and the turn's bookkeeping", async () => {
    await turn([{ say: REPLY, call: suggest }, { say: REPLY }]);

    expect(provider.calls).toHaveLength(1);
    expect(said()).toBe(REPLY);
    expect(server.calls.map((call) => call.name)).toEqual(["suggest_tasks"]);
    expect(events).toContainEqual(
      expect.objectContaining({
        type: "turn_reply",
        messageIds: ["m1"],
        text: REPLY,
        failed: false,
      })
    );
    expect(events).toContainEqual(
      expect.objectContaining({ type: "turn_complete" })
    );
    expect(events).toContainEqual({
      type: "status_changed",
      status: "idle",
    });
    expect(events.some((event) => event.type === "error")).toBe(false);
  }, 60_000);

  it("before any text keeps the turn running, so a reply is written", async () => {
    await turn([{ call: suggest }, { say: REPLY }]);

    expect(provider.calls).toHaveLength(2);
    expect(said()).toBe(REPLY);
  }, 60_000);

  it("with only leaked reasoning as text keeps the turn running", async () => {
    await turn([
      { say: "<think>They said hi.</think>", call: suggest },
      { say: REPLY },
    ]);

    expect(provider.calls).toHaveLength(2);
    expect(said()).toBe(REPLY);
  }, 60_000);

  it("with an unclosed leading reasoning block keeps the turn running", async () => {
    await turn([
      { say: "<think>They said hi; greet them back.", call: suggest },
      { say: REPLY },
    ]);

    expect(provider.calls).toHaveLength(2);
  }, 60_000);

  it("refused by the app keeps the turn running, and the fixed retry closes the reply already written", async () => {
    await turn([
      { say: REPLY, call: { name: "suggest_tasks", args: { tasks: [] } } },
      { call: suggest },
      { say: REPLY },
    ]);

    expect(server.calls).toHaveLength(2);
    expect(provider.calls).toHaveLength(2);
    expect(said()).toBe(REPLY);
  }, 60_000);

  it("with arguments the schema refuses keeps the turn running", async () => {
    await turn([
      { say: REPLY, call: { name: "suggest_tasks", args: {} } },
      { say: "Here you go." },
    ]);

    expect(server.calls).toHaveLength(0);
    expect(provider.calls).toHaveLength(2);
  }, 60_000);

  it("beside another tool runs both and keeps the turn running for that tool's result", async () => {
    await turn([
      { say: REPLY, calls: [suggest, { name: "todo", args: {} }] },
      { say: "Saved." },
    ]);

    expect(server.calls.map((call) => call.name).sort()).toEqual([
      "suggest_tasks",
      "todo",
    ]);
    expect(provider.calls).toHaveLength(2);
    expect(toolResultsSent(1).join()).toContain("saved");
  }, 60_000);

  it("after other tools, in the message that writes the reply, ends the turn", async () => {
    await turn([
      { say: "Checking.", call: { name: "todo", args: {} } },
      { say: REPLY, call: suggest },
      { say: REPLY },
    ]);

    expect(provider.calls).toHaveLength(2);
  }, 60_000);

  it("after a tool, with only narration ahead of that tool, keeps the turn running for the reply", async () => {
    await turn([
      { say: "Checking.", call: { name: "todo", args: {} } },
      { call: suggest },
      { say: REPLY },
    ]);

    expect(provider.calls).toHaveLength(3);
  }, 60_000);

  it("still answers a message the user sent while the reply was being written", async () => {
    let steered = false;
    provider.script(async (_call, index) => {
      if (index > 0) return { say: "Sure, Tuesday works." };
      if (!steered) {
        steered = true;
        await bot!.steer("actually, Tuesday?");
      }
      return { say: REPLY, call: suggest };
    });
    await bot!.send("hi", { messageId: "m1" });

    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.userText.at(-1)).toContain("Tuesday");
  }, 60_000);

  it("leaves a transcript the next turn can send: the call's result is in it", async () => {
    await turn([{ say: REPLY, call: suggest }]);
    await turn([{ say: "On it." }], "plan my week");

    expect(provider.calls).toHaveLength(2);
    expect(toolResultsSent(1).join()).toContain("buttons under your reply");
    expect(provider.calls[1]?.userText.at(-1)).toContain("plan my week");
  }, 60_000);
});

describe("another tool", () => {
  it("after a written reply does not end the turn", async () => {
    await turn([
      { say: REPLY, call: { name: "todo", args: {} } },
      { say: "Saved." },
    ]);

    expect(provider.calls).toHaveLength(2);
  }, 60_000);
});
