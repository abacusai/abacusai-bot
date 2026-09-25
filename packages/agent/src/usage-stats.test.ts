/**
 * The usage scanner's contract: what the session logs say is what the numbers
 * show: per model, per day, with errors counted (a free-tier 429 IS the
 * story), the window cut on local calendar days, and files re-read only when
 * they change.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  fetchOpenRouterKeyStatus,
  isOpenLlmPoolModel,
  UsageScanner,
} from "./usage-stats.js";

let dir: string;

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "abacusai-bot-usage-"));
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

/** Frozen "now": local noon, so date math never straddles midnight. */
const NOW = new Date(2026, 7, 20, 12, 0, 0).getTime();
const DAY = 24 * 60 * 60 * 1000;

const assistantLine = (overrides: {
  provider?: string;
  model?: string;
  responseModel?: string;
  timestamp?: number;
  stopReason?: string;
  input?: number;
  output?: number;
  cost?: number;
}): string =>
  JSON.stringify({
    type: "message",
    id: "x",
    timestamp: new Date(overrides.timestamp ?? NOW).toISOString(),
    message: {
      role: "assistant",
      provider: overrides.provider ?? "openrouter",
      model: overrides.model ?? "deepseek/deepseek-chat-v3:free",
      ...(overrides.responseModel != null
        ? { responseModel: overrides.responseModel }
        : {}),
      api: "openai-completions",
      stopReason: overrides.stopReason ?? "stop",
      timestamp: overrides.timestamp ?? NOW,
      usage: {
        input: overrides.input ?? 100,
        output: overrides.output ?? 50,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: (overrides.input ?? 100) + (overrides.output ?? 50),
        cost: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          total: overrides.cost ?? 0,
        },
      },
    },
  });

const writeSession = (name: string, lines: string[]): string => {
  const sub = path.join(dir, "--some-cwd--");

  fs.mkdirSync(sub, { recursive: true });

  const file = path.join(sub, name);

  fs.writeFileSync(file, `${lines.join("\n")}\n`, "utf8");

  return file;
};

const scanner = (): UsageScanner => new UsageScanner(dir, () => NOW);

describe("aggregation", () => {
  it("sums per model and marks the failures", async () => {
    writeSession("a.jsonl", [
      JSON.stringify({ type: "session", version: 3, id: "s" }),
      assistantLine({ input: 100, output: 50 }),
      assistantLine({ input: 200, output: 70 }),
      assistantLine({ stopReason: "error", input: 0, output: 0 }),
      assistantLine({ model: "z-ai/glm-5.2:free", input: 10, output: 5 }),
    ]);

    const summary = await scanner().summary();

    expect(summary.totals.requests).toBe(4);
    expect(summary.totals.errors).toBe(1);
    expect(summary.totals.input).toBe(310);

    const deepseek = summary.models.find((m) =>
      m.modelId.startsWith("deepseek")
    );

    expect(deepseek?.requests).toBe(3);
    expect(deepseek?.errors).toBe(1);
    expect(deepseek?.output).toBe(120);
  });

  it("splits today from the rest of the window", async () => {
    // A billed model: free-pool rows deliberately carry no dollar figure.
    const billed = { provider: "anthropic", model: "claude-opus-5" };

    writeSession("a.jsonl", [
      assistantLine({ ...billed, timestamp: NOW, cost: 1 }),
      assistantLine({ ...billed, timestamp: NOW - 2 * DAY, cost: 2 }),
    ]);

    const summary = await scanner().summary();

    expect(summary.totals.cost).toBe(3);
    expect(summary.today.cost).toBe(1);
    expect(summary.models[0]?.today.requests).toBe(1);
  });

  it("cuts the window on local calendar days, today inclusive", async () => {
    writeSession("a.jsonl", [
      assistantLine({ timestamp: NOW }),
      // 29 days back is inside a 30-day window; 31 days back is out.
      assistantLine({ timestamp: NOW - 29 * DAY }),
      assistantLine({ timestamp: NOW - 31 * DAY }),
    ]);

    expect((await scanner().summary(30)).totals.requests).toBe(2);
    expect((await scanner().summary(1)).totals.requests).toBe(1);
  });

  it("orders models by spend, then by traffic among the free ones", async () => {
    writeSession("a.jsonl", [
      assistantLine({ provider: "anthropic", model: "claude-opus-5", cost: 5 }),
      assistantLine({ model: "busy/free:free" }),
      assistantLine({ model: "busy/free:free" }),
      assistantLine({ model: "quiet/free:free" }),
    ]);

    expect((await scanner().summary()).models.map((m) => m.modelId)).toEqual([
      "claude-opus-5",
      "busy/free:free",
      "quiet/free:free",
    ]);
  });

  it("buckets the daily series and skips silent days", async () => {
    writeSession("a.jsonl", [
      assistantLine({ timestamp: NOW }),
      assistantLine({
        provider: "anthropic",
        model: "claude-opus-5",
        timestamp: NOW - 3 * DAY,
        cost: 2,
      }),
    ]);

    const daily = (await scanner().summary()).daily;

    expect(daily).toHaveLength(2);
    expect((daily[0]?.date ?? "") < (daily[1]?.date ?? "")).toBe(true);
    expect(daily[0]?.cost).toBe(2);
  });

  it("survives sessions with junk lines and no usage at all", async () => {
    writeSession("a.jsonl", [
      "not json {",
      JSON.stringify({ type: "model_change", provider: "x" }),
      JSON.stringify({ type: "message", message: { role: "user" } }),
    ]);

    expect((await scanner().summary()).totals.requests).toBe(0);
  });
});

describe("the file cache", () => {
  it("re-reads a file when it grows, and drops one that is deleted", async () => {
    const file = writeSession("a.jsonl", [assistantLine({})]);
    const scan = scanner();

    expect((await scan.summary()).totals.requests).toBe(1);

    fs.appendFileSync(file, `${assistantLine({})}\n`);
    expect((await scan.summary()).totals.requests).toBe(2);

    fs.rmSync(file);
    expect((await scan.summary()).totals.requests).toBe(0);
  });

  it("never opens a file last written before the window", async () => {
    writeSession("recent.jsonl", [assistantLine({})]);

    // Content dated inside the window, mtime far outside it. Appends move
    // mtime, so a real session log cannot look like this, which is the point:
    // the turn is missing only because the file was never opened at all.
    const stale = writeSession("stale.jsonl", [assistantLine({})]);
    const long_ago = new Date(NOW - 400 * DAY);

    fs.utimesSync(stale, long_ago, long_ago);

    expect((await scanner().summary(30)).totals.requests).toBe(1);
  });
});

describe("what a dollar figure is allowed to mean", () => {
  it("bills nothing for the models the router runs for free", async () => {
    // Gemini's catalog rate is Google's paid one, but a Studio key is served
    // under a free quota: the same call openllm.ts makes when it pools them.
    writeSession("a.jsonl", [
      assistantLine({ provider: "gemini", model: "gemini-3.6-flash", cost: 4 }),
    ]);

    const summary = await scanner().summary();

    expect(summary.models[0]?.billing).toBe("free");
    expect(summary.models[0]?.cost).toBe(0);
    expect(summary.totals.cost).toBe(0);
    expect(summary.today.cost).toBe(0);
    expect(summary.daily[0]?.cost).toBe(0);
    expect(summary.unpriced).toBe(false);
  });

  it("keeps an unknown price out of the total instead of calling it zero", async () => {
    // A catalog entry with an unparseable rate registers at cost 0, and so
    // does a self-hosted endpoint. Neither is evidence that nothing was spent.
    writeSession("a.jsonl", [
      assistantLine({ provider: "abacus", model: "some-premium", cost: 0 }),
      assistantLine({ provider: "anthropic", model: "claude-opus-5", cost: 2 }),
    ]);

    const summary = await scanner().summary();
    const unpriced = summary.models.find((m) => m.modelId === "some-premium");

    expect(unpriced?.billing).toBe("unknown");
    expect(unpriced?.requests).toBe(1);
    expect(summary.totals.cost).toBe(2);
    expect(summary.unpriced).toBe(true);
  });

  it("still calls a priced model billed", async () => {
    writeSession("a.jsonl", [
      assistantLine({ provider: "anthropic", model: "claude-opus-5", cost: 2 }),
    ]);

    const summary = await scanner().summary();

    expect(summary.models[0]?.billing).toBe("billed");
    expect(summary.models[0]?.cost).toBe(2);
    expect(summary.unpriced).toBe(false);
  });
});

describe("model ids with awkward characters", () => {
  it("counts a model whose id contains spaces and separators", async () => {
    const odd = "vendor/my model\u0000v2";

    writeSession("a.jsonl", [
      assistantLine({ provider: "anthropic", model: odd, cost: 1 }),
    ]);

    const summary = await scanner().summary();

    // Re-parsing the bucket key would have shifted a name fragment into the
    // date field, and the window filter would then have dropped the row.
    expect(summary.totals.requests).toBe(1);
    expect(summary.models[0]?.modelId).toBe(odd);
    expect(summary.models[0]?.cost).toBe(1);
  });
});

describe("pool membership by name", () => {
  it("matches the sources OpenLLM routes", () => {
    expect(isOpenLlmPoolModel("openrouter", "z-ai/glm-5.2:free")).toBe(true);
    expect(isOpenLlmPoolModel("gemini", "gemini-3.6-flash")).toBe(true);
    expect(isOpenLlmPoolModel("abacus", "route-llm-code-low")).toBe(true);
  });

  it("leaves the paid rows unbadged", () => {
    expect(isOpenLlmPoolModel("openrouter", "anthropic/claude-sonnet-5")).toBe(
      false
    );
    expect(isOpenLlmPoolModel("abacus", "claude-opus-5")).toBe(false);
    expect(isOpenLlmPoolModel("anthropic", "claude-opus-5")).toBe(false);
    expect(isOpenLlmPoolModel("deepseek", "deepseek-v4-flash")).toBe(false);
    expect(isOpenLlmPoolModel("ollama", "qwen2.5-coder:7b")).toBe(false);
  });
});

describe("the OpenRouter key lookup", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("drops the body of a rejected response", async () => {
    const cancel = vi.fn(async () => undefined);

    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: false,
        status: 401,
        body: { cancel },
        json: async () => ({}),
      }))
    );

    // An unread stream holds the socket, and the panel asks again on every
    // refresh: a wrong key would leak one per glance.
    expect(await fetchOpenRouterKeyStatus("bad-key")).toBeNull();
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("reads the account status when the key is good", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        ok: true,
        body: { cancel: vi.fn() },
        json: async () => ({
          data: { usage: 3.5, limit: 10, is_free_tier: false },
        }),
      }))
    );

    expect(await fetchOpenRouterKeyStatus("good-key")).toEqual({
      usage: 3.5,
      limit: 10,
      isFreeTier: false,
    });
  });
});

/**
 * A router is a request, not a model.
 *
 * "7 requests, 7.9K tokens, price unknown" against a row called
 * `openrouter/auto` was the report: every model the router reached collapsed
 * into one row that no catalog prices, so the panel could say neither what ran
 * nor what it cost.
 */
describe("routed turns", () => {
  it("counts the turn against the model that served it", async () => {
    writeSession("s.jsonl", [
      assistantLine({
        model: "auto",
        responseModel: "deepseek/deepseek-v4-flash",
        input: 7929,
        output: 3,
      }),
    ]);

    const summary = await new UsageScanner(dir, () => NOW).summary(30);

    expect(summary.models.map((model) => model.id)).toEqual([
      "openrouter/deepseek/deepseek-v4-flash",
    ]);
    expect(summary.models[0]?.input).toBe(7929);
  });

  it("leaves a failed turn under the id that was asked for", async () => {
    writeSession("s.jsonl", [
      assistantLine({
        model: "auto",
        stopReason: "error",
        input: 0,
        output: 0,
      }),
      assistantLine({
        model: "auto",
        responseModel: "deepseek/deepseek-v4-flash",
      }),
    ]);

    const summary = await new UsageScanner(dir, () => NOW).summary(30);
    const ids = summary.models.map((model) => model.id).sort();

    // The router's own row survives, carrying the errors it routed around,
    // which is the number that explains why a turn took four tries.
    expect(ids).toEqual([
      "openrouter/auto",
      "openrouter/deepseek/deepseek-v4-flash",
    ]);
    expect(
      summary.models.find((model) => model.id === "openrouter/auto")?.errors
    ).toBe(1);
  });

  it("recognises a free pool model reached through a router", async () => {
    writeSession("s.jsonl", [
      assistantLine({
        model: "auto",
        responseModel: "z-ai/glm-5.2:free",
      }),
    ]);

    const summary = await new UsageScanner(dir, () => NOW).summary(30);

    // Under the router's name this was "unknown"; under its own it is free,
    // which is what it actually was.
    expect(summary.models[0]?.billing).toBe("free");
    expect(summary.unpriced).toBe(false);
  });

  it("reads a variable-price sentinel as unknown, not as money back", async () => {
    writeSession("s.jsonl", [
      assistantLine({ model: "some/router", cost: -7929 }),
    ]);

    const summary = await new UsageScanner(dir, () => NOW).summary(30);

    expect(summary.totals.cost).toBe(0);
    expect(summary.models[0]?.billing).toBe("unknown");
    expect(summary.unpriced).toBe(true);
  });
});
