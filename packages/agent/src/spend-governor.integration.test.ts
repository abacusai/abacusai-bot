/**
 * What a turn spends, through the real session and a provider that bills and
 * refuses as real ones do. Each case is a shape the app has met, with round
 * invented numbers: a routine that calls tools without end, a billed chat that
 * grows past its ceiling, a price that does not follow the context, a model
 * near the end of the credits, a tier that refuses one whole turn for its size.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  FakeProvider,
  type RecordedCall,
} from "@abacus-ai/test-support/fake-provider";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  expect,
  it,
  vi,
} from "vitest";

const fake = vi.hoisted(() => ({ baseUrl: "" }));
vi.mock("./abacus-endpoint.js", async (importActual) => ({
  ...(await importActual<typeof import("./abacus-endpoint.js")>()),
  abacusV1BaseUrl: () => fake.baseUrl,
}));

const { AgentMode } = await import("./protocol.js");
type DesktopEvent = import("./protocol.js").DesktopEvent;
const { AbacusBotSession } = await import("./session.js");
const { setHostCreditBalance } = await import("./credit-balance.js");
const { setHostCreditWall } = await import("./credit-wall.js");

const BILLED = "abacus-premium-1";
const OPEN = "abacus-open-1";

let provider: FakeProvider;
let home: string;

const writeConfig = (config: Record<string, unknown>) =>
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify(config));

const start = async () => {
  const events: DesktopEvent[] = [];
  const session = new AbacusBotSession({
    cwd: fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-spend-")),
    mode: AgentMode.Yolo,
    emit: (event: DesktopEvent) => events.push(event),
  } as ConstructorParameters<typeof AbacusBotSession>[0]);
  await session.start();
  const completed = () =>
    events.filter(
      (event) => event.type === "event" && event.event.type === "turn_complete"
    ).length;
  const turn = async (text: string): Promise<RecordedCall[]> => {
    const before = provider.calls.length;
    const closed = completed();
    await session.send(text);
    const deadline = Date.now() + 60_000;
    while (completed() === closed) {
      if (Date.now() > deadline) throw new Error("turn never completed");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return provider.calls.slice(before);
  };
  const agentEvents = () =>
    events.flatMap((event) => (event.type === "event" ? [event.event] : []));
  return { session, turn, agentEvents };
};

const billedSince = (from: number) => provider.billed.slice(from);
const sum = (values: number[]) => values.reduce((a, b) => a + b, 0);

beforeAll(async () => {
  provider = await FakeProvider.start();
  fake.baseUrl = provider.baseUrl;
  provider.serveModels([
    { id: "route-llm-open", pool: [OPEN] },
    {
      id: BILLED,
      display_name: "Abacus Premium",
      model_type: "text_generation",
      context_length: 1_000_000,
    },
    {
      id: OPEN,
      display_name: "Abacus Open",
      model_type: "text_generation",
      context_length: 1_000_000,
    },
  ]);
  home = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-spend-home-"));
  fs.mkdirSync(path.join(home, "agent"), { recursive: true });
  fs.writeFileSync(
    path.join(home, "agent", "settings.json"),
    JSON.stringify({ retry: { enabled: false, provider: { maxRetries: 0 } } })
  );
  fs.writeFileSync(
    path.join(home, "user-language.json"),
    JSON.stringify({ language: { name: "English", source: "user" } })
  );
  process.env.ABACUSAI_BOT_HOME = home;
  process.env.ABACUS_API_KEY = "test-abacus-key";
}, 60_000);

beforeEach(() => {
  provider.meterWith({});
  setHostCreditWall({ exhaustedAt: null, freeLaneChosenAt: null });
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_ROUTINE_RUN;
  delete process.env.ABACUSAI_BOT_NOBODY_PRESENT;
});

afterAll(async () => {
  await provider?.close();
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.ABACUSAI_BOT_HOME;
  delete process.env.ABACUS_API_KEY;
});

it("a routine run on billed credits finishes its job, however much it spends", async () => {
  process.env.ABACUSAI_BOT_ROUTINE_RUN = "1";
  process.env.ABACUSAI_BOT_NOBODY_PRESENT = "1";
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({ remaining: 2000, granted: 3000, at: Date.now() });
  // 10 credits a request, 40 tool calls, then the report: 400+ credits.
  provider.meterWith({ credits: () => 10 });
  let calls = 0;
  provider.script(() =>
    ++calls <= 40
      ? { call: { name: "ls", args: { path: "." } } }
      : { say: "Checked the whole list." }
  );
  const from = provider.billed.length;
  const { session, turn, agentEvents } = await start();
  await turn("Run the check");
  await session.stop();

  const spent = sum(billedSince(from).map((entry) => entry.credits));
  expect(spent).toBeGreaterThan(400);
  expect(
    agentEvents().some(
      (event) =>
        (event as { type?: string }).type === "notification" &&
        JSON.stringify(event).includes("spend-limit")
    )
  ).toBe(false);
  expect(JSON.stringify(agentEvents())).toContain("Checked the whole list.");
}, 120_000);

it("a billed chat never sends more than 160k tokens, however long it grows", async () => {
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({
    remaining: 18_000,
    granted: 20_000,
    planCredits: 20_000,
    at: Date.now(),
  });
  // Billed on input: a credit for every 5,000 tokens sent.
  provider.meterWith({ credits: (tokens) => tokens / 5_000 });
  provider.script((call) =>
    JSON.stringify(call.messages).includes("summar")
      ? { say: "Summary: the user pasted long logs and asked about them." }
      : { say: "Noted." }
  );
  const from = provider.billed.length;
  const { session, turn, agentEvents } = await start();
  // Each message carries about 35k tokens of pasted log.
  const paste = "log line with some detail ".repeat(5_400);
  for (let i = 0; i < 16; i++) await turn(`Look at this log ${i}:\n${paste}`);
  await session.stop();

  const sent = billedSince(from).map((entry) => entry.tokens);
  const credits = sum(billedSince(from).map((entry) => entry.credits));
  console.log(
    `[replay] long billed chat: requests=${sent.length} maxTokens=${Math.max(...sent)} credits=${credits.toFixed(1)}`
  );
  expect(Math.max(...sent)).toBeLessThanOrEqual(160_000);
  // The chat says so, quietly.
  expect(
    agentEvents().some(
      (event) =>
        event.type === "notification" &&
        event.actions?.some((action) => action.type === "compacted")
    )
  ).toBe(true);
}, 300_000);

it("a flat price per request is never made dearer by summaries: 12 turns cost what they cost before", async () => {
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({
    remaining: 2_000,
    granted: 3_000,
    planCredits: 3_000,
    at: Date.now(),
  });
  // 70 credits a request whatever it carries: over 2% of the plan, and flat.
  provider.meterWith({ credits: () => 70 });
  provider.script((call) =>
    JSON.stringify(call.messages).includes("summar")
      ? { say: "Summary." }
      : { say: "Noted." }
  );
  const from = provider.billed.length;
  const { session, turn } = await start();
  const paste = "a line of notes ".repeat(2_500);
  for (let i = 0; i < 12; i++) await turn(`Notes ${i}:\n${paste}`);
  await session.stop();

  const requests = billedSince(from).length;
  const credits = sum(billedSince(from).map((entry) => entry.credits));
  console.log(`[replay] flat price: requests=${requests} credits=${credits}`);
  // One request a turn, as with no governor at all: no summary was bought.
  expect(requests).toBe(12);
  expect(credits).toBe(12 * 70);
}, 300_000);

it("Stop during the summary before a run ends the turn, and sends nothing", async () => {
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({
    remaining: 18_000,
    granted: 20_000,
    planCredits: 20_000,
    at: Date.now(),
  });
  let summarizing: (() => void) | null = null;
  const summaryAsked = new Promise<void>((resolve) => {
    summarizing = resolve;
  });
  provider.script((call) => {
    if (JSON.stringify(call.messages).includes("summar")) {
      summarizing?.();
      return { stall: {} };
    }
    return { say: "Noted." };
  });
  const { session, turn, agentEvents } = await start();
  const paste = "log line with some detail ".repeat(5_400);
  // Four of them stay under the ceiling; the fifth would pass it.
  for (let i = 0; i < 4; i++) await turn(`Log ${i}:\n${paste}`);
  const before = provider.calls.length;
  const closed = agentEvents().filter((e) => e.type === "turn_complete").length;
  const sending = session.send(`And this one:\n${paste}`);
  await summaryAsked;
  await session.stop();
  await sending;
  const deadline = Date.now() + 20_000;
  while (
    agentEvents().filter((e) => e.type === "turn_complete").length === closed
  ) {
    if (Date.now() > deadline) throw new Error("the turn never ended");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  // The summary was the only request: the message itself never went out.
  const after = provider.calls.slice(before);
  expect(after).toHaveLength(1);
  expect(JSON.stringify(after[0]?.messages)).toContain("summar");
}, 300_000);

it("a chat near the end of its credits is told the balance and builds what was asked", async () => {
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({
    remaining: 200,
    granted: 3000,
    paid: true,
    at: Date.now(),
  });
  provider.meterWith({ credits: () => 1 });
  // A model that reads "do not start new work" as "decline".
  provider.script((call) => {
    const sent = JSON.stringify(call.messages);
    if (/Do not start new work|Wrap up now/.test(sent))
      return { say: "DECLINED" };
    return call.messages.at(-1)?.role === "tool"
      ? { say: "Built the page." }
      : {
          call: {
            name: "write",
            args: { path: "index.html", content: "<h1>hi</h1>" },
          },
        };
  });
  const { session, turn, agentEvents } = await start();
  const calls = await turn("Build me a landing page");
  await session.stop();

  const hidden = JSON.stringify(calls.at(-1)?.messages ?? []);
  const declined = agentEvents().some(
    (event) => event.type === "text_delta" && /DECLINED/.test(event.content)
  );
  console.log(`[replay] near the end of the credits: declined=${declined}`);
  expect(hidden).toContain("200 credits left");
  expect(hidden).not.toMatch(/Do not start new work/);
  expect(declined).toBe(false);
  expect(agentEvents()).toContainEqual(
    expect.objectContaining({
      type: "notification",
      actions: [expect.objectContaining({ type: "credits-low", amount: 200 })],
    })
  );
}, 120_000);

it("a routine run near the end of its credits hears nothing about them and does its job", async () => {
  process.env.ABACUSAI_BOT_ROUTINE_RUN = "1";
  process.env.ABACUSAI_BOT_NOBODY_PRESENT = "1";
  writeConfig({ defaultModel: `abacus/${BILLED}`, customProviders: [] });
  setHostCreditBalance({ remaining: 100, granted: 3000, at: Date.now() });
  provider.script((call) =>
    call.messages.at(-1)?.role === "tool"
      ? { say: "Checked the folder." }
      : { call: { name: "ls", args: { path: "." } } }
  );
  const { session, turn } = await start();
  const calls = await turn("Run the check");
  await session.stop();
  expect(JSON.stringify(calls.at(-1)?.messages)).not.toContain("Credit note");
  expect(calls.at(-1)?.messages.at(-1)?.role).toBe("tool");
}, 120_000);

const TIER_413 =
  "Request too large for model `llama` in organization on tokens per minute (TPM): Limit 6000, Requested 30000, please reduce your message size and try again.";

const ownKeyTier = () => ({
  defaultModel: "groq/llama",
  customProviders: [
    {
      id: "groq",
      name: "Groq",
      baseUrl: provider.baseUrl,
      apiKey: "gsk-test",
      models: [{ id: "llama", name: "Llama", contextWindow: 131_072 }],
    },
  ],
});

it("a tier that refuses one whole turn moves to RouteLLM while credits are left", async () => {
  writeConfig(ownKeyTier());
  setHostCreditBalance({ remaining: 1000, granted: 3000, at: Date.now() });
  provider.meterWith({
    limits: { llama: { tokens: 1, status: 413, message: TIER_413 } },
  });
  provider.script(() => ({ say: "Here is the answer." }));
  const { session, turn, agentEvents } = await start();
  await turn("Summarize the plan");
  await session.stop();

  const errors = agentEvents().filter((event) => event.type === "error");
  const moved = agentEvents().some(
    (event) =>
      event.type === "notification" &&
      event.actions?.some((action) => action.type === "moved-to-abacus")
  );
  console.log(
    `[replay] tier refusal, credits left: moved=${moved} errors=${errors.length}`
  );
  expect(moved).toBe(true);
  expect(errors).toEqual([]);
}, 120_000);

it("with no credits the card offers only what works: no new chat when one message cannot fit", async () => {
  writeConfig(ownKeyTier());
  setHostCreditBalance({ remaining: 0, granted: 3000, at: Date.now() });
  setHostCreditWall({ exhaustedAt: Date.now(), freeLaneChosenAt: null });
  provider.meterWith({
    limits: { llama: { tokens: 1, status: 413, message: TIER_413 } },
  });
  const { session, turn, agentEvents } = await start();
  await turn("Summarize the plan");
  await session.stop();

  const error = agentEvents().find((event) => event.type === "error") as
    | { error: { message: string; actions?: Array<{ type: string }> } }
    | undefined;
  const types = error?.error.actions?.map((action) => action.type) ?? [];
  console.log(`[replay] tier refusal, no credits: actions=${types.join(",")}`);
  // A way that works: another model, or with no credits the plan's offer.
  expect(
    types.some((type) => type === "switch-model" || type === "plan-offer")
  ).toBe(true);
  expect(types).not.toContain("new-chat");
  expect(error?.error.message ?? "").not.toMatch(/new chat/i);
}, 120_000);

const walledPoolOn = async (config: Record<string, unknown>) => {
  // No Abacus here: the pool is empty, and the session falls back.
  const key = process.env.ABACUS_API_KEY;
  delete process.env.ABACUS_API_KEY;
  try {
    writeConfig({ ...config, defaultModel: "openllm/auto" });
    setHostCreditWall({ exhaustedAt: Date.now(), freeLaneChosenAt: null });
    const from = provider.calls.length;
    const { session, turn, agentEvents } = await start();
    await turn("Hello");
    await session.stop();
    return { agentEvents, keyCalls: provider.calls.length - from };
  } finally {
    process.env.ABACUS_API_KEY = key;
  }
};

it("at the credit wall, a pool that falls back onto the user's own key stops on the wall card first", async () => {
  provider.meterWith({
    limits: {
      llama: {
        tokens: 1,
        status: 429,
        message: "RESOURCE_EXHAUSTED: quota exceeded for this key",
      },
    },
  });
  const { agentEvents, keyCalls } = await walledPoolOn(ownKeyTier());
  const error = agentEvents().find((event) => event.type === "error") as
    | {
        error: {
          cause?: string;
          actions?: Array<{ type: string; ownKey?: boolean }>;
        };
      }
    | undefined;
  console.log(
    `[replay] wall with own key: cause=${error?.error.cause} actions=${error?.error.actions?.map((a) => a.type + (a.ownKey ? "(own key)" : "")).join(",")} keyCalls=${keyCalls}`
  );
  expect(error?.error.cause).toBe("credits_exhausted");
  expect(error?.error.actions).toContainEqual(
    expect.objectContaining({ type: "switch-model", ownKey: true })
  );
  expect(keyCalls).toBe(0);
}, 120_000);

it("at the credit wall, a fallback that costs nothing (a local model) runs", async () => {
  provider.script(() => ({ say: "Hi from the local model." }));
  const { agentEvents, keyCalls } = await walledPoolOn({
    customProviders: [
      {
        id: "local",
        name: "Local",
        baseUrl: provider.baseUrl,
        apiKey: "local",
        models: [{ id: "small", name: "Small", contextWindow: 32_768 }],
      },
    ],
  });
  const errors = agentEvents().filter((event) => event.type === "error");
  console.log(
    `[replay] wall with a local fallback: ${JSON.stringify(errors).slice(0, 400)}`
  );
  expect(errors).toEqual([]);
  expect(keyCalls).toBe(1);
}, 120_000);
