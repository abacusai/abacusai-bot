/**
 * RouteLLM - Open across its whole life on a free account, in one chat:
 * the Abacus credits run out, the user connects Google AI Studio, its quota
 * runs out, they connect OpenRouter, its daily allowance runs out, and they
 * connect the rest. At every step the pool must spend sources in order, say
 * "connect another source" once nothing is left, and take up a source the
 * moment it is connected, all on tool-calling turns.
 *
 * Every source is the loopback fake, told apart by the model a request
 * names; Abacus reads its catalog from it too.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  type Reply,
} from "@abacus-ai/test-support/fake-provider";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const fake = vi.hoisted(() => ({ baseUrl: "" }));
vi.mock("./abacus-endpoint.js", async (importActual) => ({
  ...(await importActual<typeof import("./abacus-endpoint.js")>()),
  abacusV1BaseUrl: () => fake.baseUrl,
}));

const { AgentMode } = await import("./protocol.js");
type DesktopEvent = import("./protocol.js").DesktopEvent;
type AgentEvent = import("./protocol.js").AgentEvent;
const { AbacusBotSession, OPENLLM_POOL_SHUT_MESSAGE } =
  await import("./session.js");

let provider: FakeProvider;
let home: string;

/** What each source's model does now; anything unlisted answers by name. */
const behaviour = new Map<string, Reply>();

const ABACUS_MODEL = "abacus-open-1";
const SOURCES = {
  gemini: { id: "gemini", models: ["gemini-3.6-flash"] },
  openrouter: { id: "openrouter", models: ["big:free"] },
  mistral: { id: "mistral", models: ["devstral-latest"] },
  nvidia: { id: "nvidia", models: ["moonshotai/kimi-k3"] },
  cerebras: { id: "cerebras", models: ["gpt-oss-120b"] },
  groq: { id: "groq", models: ["openai/gpt-oss-120b"] },
} as const;

/** Connect sources the way the app does: config on disk, then a refresh. */
const connect = (...ids: Array<keyof typeof SOURCES>): void => {
  const config = JSON.parse(
    fs.readFileSync(path.join(home, "config.json"), "utf8")
  ) as { customProviders: unknown[] };
  for (const id of ids) {
    config.customProviders.push({
      id,
      baseUrl: provider.baseUrl,
      apiKey: "test-key",
      models: SOURCES[id].models.map((model) => ({
        id: model,
        contextWindow: 131_072,
      })),
    });
  }
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));
};

const OUT_OF_ABACUS_CREDITS: Reply = {
  fail: {
    status: 429,
    message: "You have no remaining credits to use the LLM apis.",
  },
};
const GEMINI_QUOTA_SPENT: Reply = {
  fail: {
    status: 429,
    message:
      "RESOURCE_EXHAUSTED: You exceeded your current quota, please check your plan and billing details.",
  },
};
const OPENROUTER_DAY_SPENT: Reply = {
  fail: {
    status: 429,
    message: "Rate limit exceeded: free-models-per-day.",
  },
};

class Chat {
  readonly events: DesktopEvent[] = [];
  readonly session = new AbacusBotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-chain-")),
    mode: AgentMode.Yolo,
    emit: (event: DesktopEvent) => this.events.push(event),
  } as ConstructorParameters<typeof AbacusBotSession>[0]);

  agent<T extends AgentEvent["type"]>(
    type: T
  ): Array<Extract<AgentEvent, { type: T }>> {
    return this.events
      .filter(
        (event): event is Extract<DesktopEvent, { type: "event" }> =>
          event.type === "event"
      )
      .map((event) => event.event)
      .filter(
        (event): event is Extract<AgentEvent, { type: T }> =>
          event.type === type
      );
  }

  /** One user turn; returns the models it asked and how it ended. */
  async turn(text: string): Promise<{
    models: string[];
    reply: string;
    error: Extract<AgentEvent, { type: "error" }>["error"] | undefined;
  }> {
    const before = provider.calls.length;
    const turns = this.agent("turn_complete").length;
    const errors = this.agent("error").length;
    const deltas = this.agent("text_delta").length;
    await this.session.send(text);
    const deadline = Date.now() + 15_000;
    while (this.agent("turn_complete").length === turns) {
      if (Date.now() > deadline) throw new Error("turn never completed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return {
      models: provider.calls.slice(before).map((call) => call.model),
      reply: this.agent("text_delta")
        .slice(deltas)
        .map((event) => event.content)
        .join(""),
      error: this.agent("error").slice(errors)[0]?.error,
    };
  }
}

beforeAll(async () => {
  provider = await FakeProvider.start();
  fake.baseUrl = provider.baseUrl;
  // Abacus's live catalog: one model, declared the Abacus slice of the pool.
  provider.serveModels([
    { id: "route-llm-open", pool: [ABACUS_MODEL] },
    {
      id: ABACUS_MODEL,
      display_name: "Abacus Open",
      model_type: "text_generation",
      context_length: 131_072,
    },
  ]);
  // Each model's turn: one tool call, then its answer, so every source in
  // the chain is driven through a real tool round trip.
  provider.script((call) => {
    const failure = behaviour.get(call.model);
    if (failure != null) return failure;
    // Answer once this turn's call came back; call a tool otherwise.
    return call.messages.at(-1)?.role === "tool"
      ? { say: `answered on ${call.model}` }
      : { call: { name: "ls", args: { path: "." } } };
  });

  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-chain-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  // pi's own retries would re-send a failing call before the pool moves.
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
  fs.writeFileSync(
    path.join(home, "config.json"),
    JSON.stringify({ defaultModel: "openllm/auto", customProviders: [] })
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUS_API_KEY = "test-abacus-key";
}, 60_000);

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUS_API_KEY;
});

describe("RouteLLM - Open from first credit to last source", () => {
  it("spends Abacus, then Gemini, then OpenRouter, then the rest, taking each up as it is connected", async () => {
    const chat = new Chat();
    await chat.session.start();

    // 1. Abacus credits: the only source, and it works, tools included.
    let turn = await chat.turn("first task");
    expect(turn.models).toEqual([ABACUS_MODEL, ABACUS_MODEL]);
    expect(turn.reply).toContain(`answered on ${ABACUS_MODEL}`);
    expect(turn.error).toBeUndefined();

    // 2. They run out with nothing else connected: the card, not a crash.
    behaviour.set(ABACUS_MODEL, OUT_OF_ABACUS_CREDITS);
    turn = await chat.turn("second task");
    expect(turn.models).toEqual([ABACUS_MODEL]);
    expect(turn.error?.actions?.map((action) => action.type)).toContain(
      "upgrade-abacus"
    );

    // 3. Google AI Studio connected: the next turn runs on Gemini.
    connect("gemini");
    await chat.session.refreshProviders();
    turn = await chat.turn("third task");
    expect(turn.models.filter((model) => model !== ABACUS_MODEL)).toEqual([
      "gemini-3.6-flash",
      "gemini-3.6-flash",
    ]);
    expect(turn.reply).toContain("answered on gemini-3.6-flash");
    expect(turn.error).toBeUndefined();

    // Abacus stays shut for the turns after: no wasted call on it.
    turn = await chat.turn("fourth task");
    expect(turn.models).toEqual(["gemini-3.6-flash", "gemini-3.6-flash"]);

    // 4. The Studio quota runs out too: shut, and saying so.
    behaviour.set("gemini-3.6-flash", GEMINI_QUOTA_SPENT);
    turn = await chat.turn("fifth task");
    expect(turn.models).toEqual(["gemini-3.6-flash"]);
    expect(turn.error?.message).toBe(OPENLLM_POOL_SHUT_MESSAGE);

    // 5. OpenRouter connected: its free models take over.
    connect("openrouter");
    await chat.session.refreshProviders();
    turn = await chat.turn("sixth task");
    expect(turn.models.at(-1)).toBe("big:free");
    expect(turn.models.filter((model) => model === "big:free")).toHaveLength(2);
    expect(turn.reply).toContain("answered on big:free");
    expect(turn.error).toBeUndefined();

    // 6. Its daily free allowance runs out.
    behaviour.set("big:free", OPENROUTER_DAY_SPENT);
    turn = await chat.turn("seventh task");
    expect(turn.error?.message).toBe(OPENLLM_POOL_SHUT_MESSAGE);

    // 7. The rest connected at once: Mistral first.
    connect("mistral", "nvidia", "cerebras", "groq");
    await chat.session.refreshProviders();
    turn = await chat.turn("eighth task");
    expect(turn.models.slice(-2)).toEqual([
      "devstral-latest",
      "devstral-latest",
    ]);
    expect(turn.reply).toContain("answered on devstral-latest");

    // 8. Each of the rest fails its own way, inside one turn, and the turn
    //    walks the order to the last one standing.
    behaviour.set("devstral-latest", {
      fail: { status: 401, message: "Invalid API Key" },
    });
    behaviour.set("moonshotai/kimi-k3", {
      fail: {
        status: 429,
        message: "Rate limit reached. Please try again in 5m0s.",
      },
    });
    behaviour.set("gpt-oss-120b", {
      fail: { status: 410, message: "Gone" },
    });
    turn = await chat.turn("ninth task");
    expect(turn.models).toEqual([
      "devstral-latest",
      "moonshotai/kimi-k3",
      "gpt-oss-120b",
      "openai/gpt-oss-120b",
      "openai/gpt-oss-120b",
    ]);
    expect(turn.reply).toContain("answered on openai/gpt-oss-120b");
    expect(turn.error).toBeUndefined();
  }, 60_000);
});

describe("the same chain in a bot's chat", () => {
  it("moves a bot from Abacus to each source as it is connected", async () => {
    const { BotSession } = await import("./bot/bot-session.js");
    behaviour.clear();
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "openllm/auto", customProviders: [] })
    );
    for (const file of ["openllm-cooldowns.json", "openllm-quota.json"])
      fs.rmSync(path.join(home, file), { force: true });
    const botDir = path.join(home, "bots", "bot-1");
    fs.mkdirSync(botDir, { recursive: true });
    process.env.ABACUSAI_BOT_BOT_DIR = botDir;

    const events: DesktopEvent[] = [];
    const bot = new BotSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-chain-bot-")),
      mode: "yolo",
      emit: (event: DesktopEvent) => events.push(event),
    } as ConstructorParameters<typeof BotSession>[0]);
    const turn = async (text: string) => {
      const before = provider.calls.length;
      const seen = events.length;
      await bot.send(text);
      const fresh = events
        .slice(seen)
        .filter(
          (event): event is Extract<DesktopEvent, { type: "event" }> =>
            event.type === "event"
        )
        .map((event) => event.event);
      return {
        models: provider.calls.slice(before).map((call) => call.model),
        reply: fresh
          .map((event) => (event.type === "text_delta" ? event.content : ""))
          .join(""),
        failed: fresh.some((event) => event.type === "error"),
      };
    };

    await bot.start();
    let result = await turn("check my inbox");
    expect(result.models).toEqual([ABACUS_MODEL, ABACUS_MODEL]);
    expect(result.failed).toBe(false);

    behaviour.set(ABACUS_MODEL, OUT_OF_ABACUS_CREDITS);
    result = await turn("again");
    expect(result.failed).toBe(true);

    connect("gemini");
    await bot.refreshProviders();
    result = await turn("again");
    expect(result.reply).toContain("answered on gemini-3.6-flash");
    expect(result.failed).toBe(false);

    behaviour.set("gemini-3.6-flash", GEMINI_QUOTA_SPENT);
    connect("openrouter");
    await bot.refreshProviders();
    result = await turn("again");
    expect(result.reply).toContain("answered on big:free");

    behaviour.set("big:free", OPENROUTER_DAY_SPENT);
    connect("mistral");
    await bot.refreshProviders();
    result = await turn("again");
    expect(result.reply).toContain("answered on devstral-latest");
    expect(result.failed).toBe(false);

    await bot.stop?.();
    delete process.env.ABACUSAI_BOT_BOT_DIR;
  }, 60_000);
});
