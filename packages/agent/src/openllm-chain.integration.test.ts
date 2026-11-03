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
import { createRequire, syncBuiltinESMExports } from "node:module";
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
const { AbacusBotSession } = await import("./session.js");
const { OPENLLM_POOL_SHUT_MESSAGE } = await import("./turn-outcome.js");
const { creditWallState, noteCreditsBack, setHostCreditWall } =
  await import("./credit-wall.js");

/** What the desktop does when the user picks "Continue with free models". */
const chooseFreeLane = (): void =>
  setHostCreditWall({
    ...creditWallState(),
    freeLaneChosenAt: Date.now(),
  });

let provider: FakeProvider;
let home: string;

/** What each source's model does now; anything unlisted answers by name. */
const behaviour = new Map<string, Reply>();

const ABACUS_MODEL = "abacus-open-1";
const SOURCES = {
  gemini: { id: "gemini", models: ["gemini-3.6-flash"] },
  openrouter: { id: "openrouter", models: ["big:free"] },
  mistral: { id: "mistral", models: ["devstral-latest"] },
  nvidia: { id: "nvidia", models: ["moonshotai/kimi-k2.6"] },
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
  // A saved language: detecting one would be one more call to the fake pool.
  fs.writeFileSync(
    path.join(home, "user-language.json"),
    JSON.stringify({ language: { name: "English", source: "user" } })
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

    // 3. Google AI Studio connected: no turn moves onto it before the user
    //    has seen the wall and chosen the free models.
    connect("gemini");
    await chat.session.refreshProviders();
    turn = await chat.turn("third task");
    expect(turn.models.filter((model) => model !== ABACUS_MODEL)).toEqual([]);
    expect(turn.error?.cause).toBe("credits_exhausted");
    expect(turn.error?.actions).toContainEqual({
      type: "continue-free",
      providers: ["gemini"],
    });

    // Chosen: the turn runs on Gemini, labelled as the free lane.
    chooseFreeLane();
    turn = await chat.turn("third task");
    expect(turn.models.filter((model) => model !== ABACUS_MODEL)).toEqual([
      "gemini-3.6-flash",
      "gemini-3.6-flash",
    ]);
    expect(turn.reply).toContain("answered on gemini-3.6-flash");
    expect(turn.error).toBeUndefined();

    expect(chat.agent("turn_complete").at(-1)?.usage).toMatchObject({
      lane: "free",
      provider: "gemini",
    });

    // Abacus stays shut for the turns after: no wasted call on it, and the
    // choice is not asked for again.
    const errorsBefore = chat.agent("error").length;
    turn = await chat.turn("fourth task");
    expect(turn.models).toEqual(["gemini-3.6-flash", "gemini-3.6-flash"]);
    expect(chat.agent("error")).toHaveLength(errorsBefore);

    // 4. The Studio quota runs out too: shut, and saying so.
    behaviour.set("gemini-3.6-flash", GEMINI_QUOTA_SPENT);
    turn = await chat.turn("fifth task");
    expect(turn.models).toEqual(["gemini-3.6-flash"]);
    expect(turn.error?.message).toBe(OPENLLM_POOL_SHUT_MESSAGE);
    // On the free lane a failed turn comes back to the wall's card.
    expect(turn.error?.actions?.[0]).toMatchObject({ type: "upgrade-abacus" });

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
    // A free account is offered the plan rather than "try again".
    expect(turn.error?.actions?.map((action) => action.type)).toContain(
      "upgrade-abacus"
    );

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
    behaviour.set("moonshotai/kimi-k2.6", {
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
      "moonshotai/kimi-k2.6",
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
    noteCreditsBack();
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
      const completed = (): number =>
        events.filter(
          (event) =>
            event.type === "event" && event.event.type === "turn_complete"
        ).length;
      const turns = completed();
      await bot.send(text);
      // send can settle before the turn's last events land, as Chat.turn
      // waits out above; a slow runner read the reply before its text.
      const deadline = Date.now() + 15_000;
      while (completed() === turns) {
        if (Date.now() > deadline) throw new Error("turn never completed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
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
        // What a reply missing on a slow runner looked like, for the log.
        trace: JSON.stringify({
          models: provider.calls.slice(before).map((call) => call.model),
          events: fresh.map((event) => event.type),
          errors: fresh.filter((event) => event.type === "error"),
        }),
      };
    };

    await bot.start();
    let result = await turn("check my inbox");
    expect(result.models).toEqual([ABACUS_MODEL, ABACUS_MODEL]);
    expect(result.failed).toBe(false);

    behaviour.set(ABACUS_MODEL, OUT_OF_ABACUS_CREDITS);
    result = await turn("again");
    expect(result.failed).toBe(true);

    // A connected source is not taken up before the free lane is chosen.
    connect("gemini");
    await bot.refreshProviders();
    result = await turn("again");
    expect(result.failed, result.trace).toBe(true);
    expect(result.models).not.toContain("gemini-3.6-flash");

    chooseFreeLane();
    result = await turn("again");
    expect(result.reply, result.trace).toContain(
      "answered on gemini-3.6-flash"
    );
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

describe("the credit wall, around the pool", () => {
  it("leaves an account with credits unchanged: Abacus answers, no notice, no free-lane label", async () => {
    behaviour.clear();
    noteCreditsBack();
    for (const file of ["openllm-cooldowns.json", "openllm-quota.json"])
      fs.rmSync(path.join(home, file), { force: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "openllm/auto", customProviders: [] })
    );
    connect("gemini");
    const chat = new Chat();
    await chat.session.start();

    const turn = await chat.turn("a task");
    expect(turn.models).toEqual([ABACUS_MODEL, ABACUS_MODEL]);
    expect(turn.error).toBeUndefined();
    expect(chat.agent("turn_complete").at(-1)?.usage?.lane).toBeUndefined();
  }, 60_000);

  it("leaves a pinned Abacus model as it was: its own card, no free lane, no other provider asked", async () => {
    behaviour.clear();
    noteCreditsBack();
    for (const file of ["openllm-cooldowns.json", "openllm-quota.json"])
      fs.rmSync(path.join(home, file), { force: true });
    const chat = new Chat();
    await chat.session.start();
    await chat.session.setModel(`abacus/${ABACUS_MODEL}`);
    behaviour.set(ABACUS_MODEL, OUT_OF_ABACUS_CREDITS);

    const turn = await chat.turn("a task");
    expect(turn.models).toEqual([ABACUS_MODEL]);
    expect(turn.error?.actions?.[0]).toEqual({
      type: "upgrade-abacus",
      cause: "exhausted",
    });
    expect(
      turn.error?.actions?.some((action) => action.type === "continue-free")
    ).toBe(false);
  }, 60_000);
});

describe("a model the user picked off Abacus that fails", () => {
  const KIMI = SOURCES.nvidia.models[0];
  const reset = (): void => {
    behaviour.clear();
    noteCreditsBack();
    for (const file of ["openllm-cooldowns.json", "openllm-quota.json"])
      fs.rmSync(path.join(home, file), { force: true });
    fs.writeFileSync(
      path.join(home, "config.json"),
      JSON.stringify({ defaultModel: "openllm/auto", customProviders: [] })
    );
    connect("nvidia");
  };
  const pinned = async (): Promise<Chat> => {
    const chat = new Chat();
    await chat.session.start();
    await chat.session.setModel(`nvidia/${KIMI}`);
    return chat;
  };
  const moves = (chat: Chat) =>
    chat
      .agent("notification")
      .filter((notice) =>
        (notice.actions ?? []).some(
          (action) => action.type === "moved-to-abacus"
        )
      );

  it.each([
    ["gone", { fail: { status: 410, message: "status code (no body)" } }],
    ["rate limited", { fail: { status: 429, message: "Rate limit reached." } }],
    ["down", { fail: { status: 503, message: "Service Unavailable" } }],
    ["unclassified", { fail: { status: 400, message: "Unexpected reply" } }],
    ["a refused key", { fail: { status: 401, message: "Invalid API Key" } }],
    ["a spent key", { fail: { status: 402, message: "Insufficient Balance" } }],
    ["an empty reply", { say: "" }],
    ["a stall", { stall: {} }],
  ] as Array<[string, Reply]>)(
    "%s with Abacus credits left: the message runs on RouteLLM - Open, the chat moves there and says so",
    async (_name, failure) => {
      reset();
      behaviour.set(KIMI, failure);
      // The stall window, short enough for a test.
      process.env.ABACUSAI_BOT_MODEL_STALL_MS = "700";
      const chat = await pinned();

      const turn = await chat.turn("a task");
      delete process.env.ABACUSAI_BOT_MODEL_STALL_MS;
      expect(turn.models[0]).toBe(KIMI);
      expect(turn.models.slice(-2)).toEqual([ABACUS_MODEL, ABACUS_MODEL]);
      expect(turn.reply).toContain(`answered on ${ABACUS_MODEL}`);
      expect(turn.error).toBeUndefined();
      expect(moves(chat)).toHaveLength(1);
      expect(moves(chat)[0]?.actions?.[0]).toMatchObject({
        type: "moved-to-abacus",
        provider: "nvidia",
        label: KIMI,
        free: true,
      });
      // The chat's model is RouteLLM - Open now (main persists it).
      expect(chat.agent("model_changed").at(-1)?.model).toBe("openllm/auto");
      expect(moves(chat)[0]?.actions?.[0]).toMatchObject({
        target: "RouteLLM - Open",
      });
      expect(chat.agent("turn_complete").at(-1)?.outcome).toEqual({
        kind: "reply",
      });
    },
    30_000
  );

  it("moves once per message: RouteLLM - Open failing too ends on its own error", async () => {
    reset();
    behaviour.set(KIMI, { fail: { status: 410, message: "Gone" } });
    behaviour.set(ABACUS_MODEL, { fail: { status: 500, message: "Boom" } });
    const chat = await pinned();

    const turn = await chat.turn("a task");
    expect(turn.models.slice(0, 2)).toEqual([KIMI, ABACUS_MODEL]);
    // One move; after it the pool's own rotation decides, as for any turn on it.
    expect(moves(chat)).toHaveLength(1);
    expect(turn.error).toBeDefined();
    // The router's ending, never the picked model's card again.
    expect(
      turn.error?.actions?.some(
        (action) => action.type === "own-key-unavailable"
      )
    ).toBe(false);
  }, 30_000);

  it("the disk fills between turns: the next ends on the full-disk card with Retry, not on the model, and does not move", async () => {
    reset();
    const chat = await pinned();
    // A first turn with room: the session file exists, later turns append.
    behaviour.set(KIMI, { say: "first answer" });
    expect((await chat.turn("a first task")).error).toBeUndefined();
    behaviour.delete(KIMI);
    // Every write from here fails as Node fails it on a full disk; pi's own
    // session file (named imports of fs) sees it through the synced exports.
    const enospc = (): never => {
      throw Object.assign(new Error("ENOSPC: no space left on device, write"), {
        errno: -28,
        code: "ENOSPC",
        syscall: "write",
      });
    };
    const nodeFs = createRequire(import.meta.url)("node:fs") as typeof fs;
    const writes = [
      vi.spyOn(nodeFs, "writeFileSync").mockImplementation(enospc),
      vi.spyOn(nodeFs, "appendFileSync").mockImplementation(enospc),
    ];
    syncBuiltinESMExports();
    try {
      const turn = await chat.turn("a task");
      expect(turn.error).toMatchObject({
        cause: "disk_full",
        code: "turn_failed",
        actions: [{ type: "retry", bytesFree: expect.any(Number) }],
      });
      expect(moves(chat)).toHaveLength(0);
    } finally {
      for (const write of writes) write.mockRestore();
      syncBuiltinESMExports();
    }
  }, 30_000);

  it("a paying plan runs on its own low code router: the chat's model names it, never RouteLLM - Open", async () => {
    reset();
    behaviour.set(KIMI, { fail: { status: 410, message: "Gone" } });
    // A paying catalog lists the standard code router.
    provider.serveModels([
      { id: "route-llm-open", pool: [ABACUS_MODEL] },
      {
        id: ABACUS_MODEL,
        display_name: "Abacus Open",
        model_type: "text_generation",
        context_length: 131_072,
      },
      {
        id: "route-llm-code",
        display_name: "RouteLLM (Code)",
        model_type: "text_generation",
        context_length: 131_072,
      },
      {
        id: "route-llm-code-low",
        display_name: "RouteLLM (Code, Low)",
        model_type: "text_generation",
        context_length: 131_072,
      },
    ]);
    try {
      const chat = await pinned();
      const turn = await chat.turn("a task");
      // The plan's own router, which a paying plan's picker lists.
      expect(turn.models.slice(-2)).toEqual([
        "route-llm-code-low",
        "route-llm-code-low",
      ]);
      expect(turn.error).toBeUndefined();
      expect(chat.agent("model_changed").at(-1)?.model).toBe(
        "abacus/route-llm-code-low"
      );
      expect(moves(chat)[0]?.actions?.[0]).toMatchObject({
        target: "RouteLLM",
      });
    } finally {
      provider.serveModels([
        { id: "route-llm-open", pool: [ABACUS_MODEL] },
        {
          id: ABACUS_MODEL,
          display_name: "Abacus Open",
          model_type: "text_generation",
          context_length: 131_072,
        },
      ]);
    }
  }, 30_000);

  it("out of Abacus credits: no move, the card offers the plan", async () => {
    reset();
    behaviour.set(KIMI, { fail: { status: 410, message: "Gone" } });
    setHostCreditWall({ exhaustedAt: Date.now(), freeLaneChosenAt: null });
    const chat = await pinned();

    const turn = await chat.turn("a task");
    expect(turn.models).toEqual([KIMI]);
    expect(moves(chat)).toHaveLength(0);
    expect(turn.error?.actions).toEqual([
      {
        type: "own-key-unavailable",
        provider: "nvidia",
        cause: "gone",
        model: `nvidia/${KIMI}`,
        label: KIMI,
        free: true,
      },
    ]);
    noteCreditsBack();
  }, 30_000);

  it("signed out: no move, and the card is today's", async () => {
    reset();
    behaviour.set(KIMI, { fail: { status: 410, message: "Gone" } });
    delete process.env.ABACUS_API_KEY;
    try {
      const chat = await pinned();
      const turn = await chat.turn("a task");
      expect(turn.models).toEqual([KIMI]);
      expect(moves(chat)).toHaveLength(0);
      expect(turn.error?.actions).toEqual([{ type: "switch-model" }]);
    } finally {
      process.env.ABACUS_API_KEY = "test-abacus-key";
    }
  }, 30_000);

  it("in a bot's chat too: the message runs on RouteLLM - Open and the chat is told", async () => {
    const { BotSession } = await import("./bot/bot-session.js");
    reset();
    behaviour.set(KIMI, { fail: { status: 410, message: "Gone" } });
    const botDir = path.join(home, "bots", "bot-2");
    fs.mkdirSync(botDir, { recursive: true });
    process.env.ABACUSAI_BOT_BOT_DIR = botDir;
    const events: DesktopEvent[] = [];
    const bot = new BotSession({
      cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-chain-bot-")),
      mode: "yolo",
      emit: (event: DesktopEvent) => events.push(event),
    } as ConstructorParameters<typeof BotSession>[0]);
    const agent = () =>
      events
        .filter(
          (event): event is Extract<DesktopEvent, { type: "event" }> =>
            event.type === "event"
        )
        .map((event) => event.event);
    try {
      await bot.start();
      await bot.setModel(`nvidia/${KIMI}`);
      const before = provider.calls.length;
      await bot.send("check my inbox");
      const deadline = Date.now() + 15_000;
      while (!agent().some((event) => event.type === "turn_complete")) {
        if (Date.now() > deadline) throw new Error("turn never completed");
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      const models = provider.calls.slice(before).map((call) => call.model);
      expect(models[0]).toBe(KIMI);
      expect(models.at(-1)).toBe(ABACUS_MODEL);
      expect(agent().some((event) => event.type === "error")).toBe(false);
      expect(
        agent().some(
          (event) =>
            event.type === "notification" &&
            (event.actions ?? []).some(
              (action) => action.type === "moved-to-abacus"
            )
        )
      ).toBe(true);
    } finally {
      await bot.stop?.();
      delete process.env.ABACUSAI_BOT_BOT_DIR;
    }
  }, 30_000);
});
