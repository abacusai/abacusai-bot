/**
 * `browser_task` run for real: a bot chat, its sub-agent session, a browser
 * MCP server and a scripted model. What is under test is what the chat's model
 * reads back from a run, which only the whole path can show.
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
  type RecordedCall,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { BotSession } from "./bot/bot-session.js";
import { DISPATCH_LIMIT } from "./browser-task-tool.js";
import type { ForeverEngine } from "./forever/engine.js";

const REPORT =
  "The export finished and the file is listed under Reports. " +
  "Step 3 is done: the new filter is saved.";
const FOLLOW_UP = "**Invoice total:** 120.00, unchanged.";

let provider: FakeProvider;
let server: FakeMcpServer;
let home: string;
let bot: ForeverEngine | null = null;

const inRun = (call: RecordedCall): boolean =>
  call.tools.includes("browser_navigate");

/** What the chat's model read back from each browser_task it called. */
const toolResults = (): string[] => {
  const last = provider.calls.filter((call) => !inRun(call)).at(-1);
  return (last?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map((message) =>
      typeof message.content === "string"
        ? message.content
        : JSON.stringify(message.content)
    );
};

const asksForRun = (fields?: string[], step = 1): Reply => ({
  call: {
    name: "browser_task",
    args: {
      task: `Run the export and read the result back, step ${step}`,
      ...(fields != null ? { report_fields: fields } : {}),
    },
  },
});

/** A chat that starts one run per user message, and a run that reports at once. */
const scriptChat = (run: (call: RecordedCall, turn: number) => Reply): void => {
  let turn = 0;
  provider.script((call) => {
    if (inRun(call)) return run(call, ++turn);
    return call.messages.at(-1)?.role === "tool"
      ? { say: "All done." }
      : asksForRun();
  });
};

/** A chat asking for a field the report skips, and a run that answers the nudge. */
const scriptNudged = (nudged: Reply): void => {
  provider.script((call) => {
    if (inRun(call))
      return call.userText.at(-1)?.includes("does not mention")
        ? nudged
        : { say: REPORT };
    return call.messages.at(-1)?.role === "tool"
      ? { say: "All done." }
      : asksForRun(["invoice total"]);
  });
};

beforeAll(async () => {
  provider = await FakeProvider.start();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-browser-home-"));
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
  server = await FakeMcpServer.start([{ name: "browser_navigate" }]);
  const configPath = path.join(home, "mcp.json");
  fs.writeFileSync(
    configPath,
    mcpConfig({ browser: { url: server.url, isBuiltin: true } }),
    "utf8"
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUSAI_BOT_BOT_DIR = botDir;
  process.env.ABACUSAI_BOT_MCP_CONFIG = configPath;
  process.env.ABACUSAI_BOT_PHONE_DIR = path.join(home, "phone");
  process.env.PI_OFFLINE = "1";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  await server?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUSAI_BOT_BOT_DIR;
  delete process.env.ABACUSAI_BOT_MCP_CONFIG;
  delete process.env.ABACUSAI_BOT_PHONE_DIR;
});

afterEach(() => {
  bot?.dispose();
  bot = null;
  provider.calls.length = 0;
  provider.script(() => ({ say: "ok" }));
});

const startBot = async (): Promise<ForeverEngine> => {
  bot = new BotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-browser-")),
    mode: "yolo",
    emit: () => {},
  });
  await bot.start();
  return bot;
};

describe("a run whose report is sent back for a missing field", () => {
  it("hands back the whole report with the answer after it", async () => {
    scriptNudged({ say: FOLLOW_UP });
    await (await startBot()).send("run the export");

    const [result] = toolResults();
    expect(result).toContain(REPORT);
    expect(result).toContain(FOLLOW_UP);
    expect(result!.indexOf(REPORT)).toBeLessThan(result!.indexOf(FOLLOW_UP));
  }, 60_000);

  it("tells the run its report is kept, so it writes only what was missing", async () => {
    scriptNudged({ say: FOLLOW_UP });
    await (await startBot()).send("run the export");

    const nudge = provider.calls.filter(inRun).at(-1)?.userText.at(-1);
    expect(nudge).toMatch(/invoice total/);
    expect(nudge).toMatch(/kept/);
  }, 60_000);

  it("keeps the report when the follow-up says nothing", async () => {
    scriptNudged({ say: "" });
    await (await startBot()).send("run the export");

    const [result] = toolResults();
    expect(result).toContain(REPORT);
    expect(result!.split(REPORT)).toHaveLength(2);
  }, 60_000);

  it("keeps the report, as finished, when the model fails on the follow-up", async () => {
    scriptNudged({ fail: { status: 400, message: "bad request" } });
    await (await startBot()).send("run the export");

    const [result] = toolResults();
    expect(result).toContain(REPORT);
    expect(result).not.toMatch(/failed|could not reach/);
  }, 60_000);
});

describe("a run that spends its budget on the follow-up", () => {
  it("keeps the report, with the closing note after it", async () => {
    let looks = 0;
    provider.script((call) => {
      // Its tools are off by then, so this comes before asking which session.
      if (call.userText.at(-1)?.includes("tools are now off"))
        return { say: "Closing: the invoice total stayed out of reach." };
      if (!inRun(call))
        return call.messages.at(-1)?.role === "tool"
          ? { say: "All done." }
          : asksForRun(["invoice total"]);
      if (!call.userText.some((text) => text.includes("does not mention")))
        return { say: REPORT };
      looks += 1;
      return {
        call: {
          name: "browser_navigate",
          args: { url: `https://example.test/${looks}` },
        },
      };
    });
    await (await startBot()).send("run the export");

    const [result] = toolResults();
    expect(looks).toBeGreaterThan(0);
    expect(result).toContain(REPORT);
    expect(result).toContain("Closing: the invoice total stayed out of reach.");
  }, 60_000);
});

describe("a report nothing was missing from", () => {
  it("is handed back as written, once", async () => {
    scriptChat(() => ({ say: REPORT }));
    await (await startBot()).send("run the export");

    expect(toolResults()[0]).toContain(REPORT);
    expect(provider.calls.filter(inRun)).toHaveLength(1);
  }, 60_000);
});

describe("the browser budget, across the user's messages", () => {
  const spendBudget = async (engine: ForeverEngine): Promise<void> => {
    let runsAsked = 0;
    provider.script((call) => {
      if (inRun(call)) return { say: REPORT };
      if (runsAsked > DISPATCH_LIMIT) return { say: "Shall I go on?" };
      runsAsked += 1;
      return asksForRun(undefined, runsAsked);
    });
    await engine.send("do all of it");
  };

  it("says when the next run can start, and a run still in the same message stays refused", async () => {
    const engine = await startBot();
    await spendBudget(engine);

    expect(provider.calls.filter(inRun)).toHaveLength(DISPATCH_LIMIT);
    const refusal = toolResults().at(-1);
    expect(refusal).toMatch(/next run can start in (\d+) minutes?/);
  }, 60_000);

  it("runs again once the user has answered", async () => {
    const engine = await startBot();
    await spendBudget(engine);
    const before = provider.calls.filter(inRun).length;

    scriptChat(() => ({ say: REPORT }));
    await engine.send("yes, go on");

    expect(provider.calls.filter(inRun).length).toBeGreaterThan(before);
    expect(toolResults().at(-1)).toContain(REPORT);
  }, 60_000);
});

// Last: a run given up on mid-retry still sends the request it had scheduled.
describe("a run whose model stays down on the follow-up", () => {
  it("keeps the report when retries on the follow-up run out", async () => {
    const settings = path.join(home, "agent", "settings.json");
    const before = fs.readFileSync(settings, "utf8");
    fs.writeFileSync(
      settings,
      JSON.stringify({ retry: { enabled: true, baseDelayMs: 1 } }),
      "utf8"
    );
    try {
      scriptNudged({ fail: { status: 503, message: "overloaded" } });
      await (await startBot()).send("run the export");
    } finally {
      fs.writeFileSync(settings, before, "utf8");
    }

    const [result] = toolResults();
    expect(result).toContain(REPORT);
    expect(result).not.toMatch(/could not reach/);
  }, 60_000);
});
