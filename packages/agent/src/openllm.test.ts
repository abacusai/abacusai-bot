/**
 * OpenLLM's contract: given the live model list, it always has a next-best
 * free model to hand — Abacus's drivers first, then Gemini's Studio quota,
 * then OpenRouter's free tier ranked toward the families that can drive an
 * agent loop — skipping whatever failed in the last few minutes, and never
 * inventing a model that is not part of the free pool.
 *
 * The rotation state is the part worth pinning hardest. The failure mode it
 * exists for is a shared upstream quota: when one free model 429s, the next
 * turn must not start back on it, and when *every* candidate has failed
 * recently the router must still answer with something rather than escalate
 * "everything is rate-limited" into "there is no model at all".
 */
import { describe, expect, it } from "vitest";

import {
  isOpenLlmReference,
  OPENLLM_COOLDOWN_MS,
  OPENLLM_ID,
  openLlmCandidates,
  cooldownForFailures,
  OPENLLM_COOLDOWN_STEPS_MS,
  OpenLlmRotation,
  OPENLLM_ACCOUNT_COOLDOWN_MS,
  accountWideFailure,
} from "./openllm.js";
import type { ModelChoice } from "./providers.js";

const choice = (
  overrides: Partial<ModelChoice> & { id: string }
): ModelChoice => ({
  provider: overrides.id.split("/")[0] ?? "openrouter",
  modelId: overrides.id.split("/").slice(1).join("/"),
  label: overrides.id,
  free: true,
  inputCost: 0,
  reasoning: false,
  contextWindow: 128_000,
  ...overrides,
});

describe("recognising the router's id", () => {
  it("matches the virtual id exactly, with stray whitespace forgiven", () => {
    expect(isOpenLlmReference(OPENLLM_ID)).toBe(true);
    expect(isOpenLlmReference(`  ${OPENLLM_ID} `)).toBe(true);
  });

  it("does not match anything pi should resolve instead", () => {
    // Near-misses matter: the id is intercepted before pi's fuzzy resolver,
    // so a loose match here would swallow a real model reference.
    expect(isOpenLlmReference("openllm/other")).toBe(false);
    expect(isOpenLlmReference("openrouter/auto")).toBe(false);
    expect(isOpenLlmReference("abacus/route-llm")).toBe(false);
    expect(isOpenLlmReference(undefined)).toBe(false);
    expect(isOpenLlmReference(null)).toBe(false);
    expect(isOpenLlmReference("")).toBe(false);
  });
});

describe("which models are in the pool", () => {
  it("keeps OpenRouter's free tier and drops its paid models", () => {
    const candidates = openLlmCandidates([
      choice({ id: "openrouter/deepseek/deepseek-chat:free" }),
      choice({ id: "openrouter/anthropic/claude-sonnet-5", free: false }),
    ]);

    expect(candidates.map((c) => c.id)).toEqual([
      "openrouter/deepseek/deepseek-chat:free",
    ]);
  });

  it("keeps Gemini despite its catalog cost — the Studio quota is the point", () => {
    // The registered cost is the paid rate; a Google AI Studio key serves the
    // same models under a real daily free quota. Filtering on cost alone
    // would throw away the second-largest free source.
    const candidates = openLlmCandidates([
      choice({ id: "gemini/gemini-3.6-flash", free: false }),
    ]);

    expect(candidates).toHaveLength(1);
  });

  it("pools the models the app serves on this machine, after every cloud source", () => {
    const pool = openLlmCandidates([
      choice({ id: "local/qwen3.5-4b", free: true }),
      choice({ id: "openrouter/z-ai/glm-5.2:free" }),
      choice({ id: "gemini/gemini-3.5-flash-lite", free: false }),
    ]);

    expect(pool.map((model) => model.id)).toEqual([
      "gemini/gemini-3.5-flash-lite",
      "openrouter/z-ai/glm-5.2:free",
      "local/qwen3.5-4b",
    ]);
  });

  it("keeps a custom provider out, however it is named", () => {
    // A user's own endpoint is not a free tier the pool may spend.
    expect(
      openLlmCandidates([choice({ id: "ollama/qwen2.5-coder:7b" })])
    ).toEqual([]);
  });

  it("orders the Abacus slice as the platform ranked it, unranked last", () => {
    // The catalog's `route-llm-open` entry carries the order (providers.ts
    // turns it into poolRank), so a reorder, a new $0 model or a retired one
    // never waits on a release. Neither family nor context window has a say.
    const abacus = (modelId: string, poolRank?: number) =>
      choice({
        id: `abacus/${modelId}`,
        free: false,
        inputCost: 0.22,
        poolEligible: true,
        ...(poolRank == null ? {} : { poolRank }),
      });
    const candidates = openLlmCandidates([
      abacus("deepseek-ai/DeepSeek-V4-Flash-0731", 4),
      abacus("muse-spark-1.3", 2),
      abacus("deepseek-ai/DeepSeek-V4.1-Flash", 3),
      abacus("stealth/union-alpha", 1),
      abacus("some/newcomer"),
      abacus("deepseek-ai/DeepSeek-V4-Flash-Vision-Exp", 0),
    ]);

    expect(candidates.map((c) => c.modelId)).toEqual([
      "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
      "stealth/union-alpha",
      "muse-spark-1.3",
      "deepseek-ai/DeepSeek-V4.1-Flash",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
      "some/newcomer",
    ]);
  });

  it("admits the Abacus models the provider flagged, and no others", () => {
    // Membership is the provider's poolEligible flag, not a price line: a
    // free-tier account's whole catalog is the pool by definition, and a
    // hardcoded price ceiling is what emptied the pool when rates drifted
    // past it. Unflagged models stay out however cheap they look.
    const candidates = openLlmCandidates([
      choice({
        id: "abacus/route-llm-code-low",
        free: false,
        inputCost: 0.22,
        poolEligible: true,
        poolRank: 0,
      }),
      choice({
        id: "abacus/deepseek-ai/DeepSeek-V4-Flash-0731",
        free: false,
        inputCost: 0.22,
        poolEligible: true,
        poolRank: 1,
      }),
      choice({ id: "abacus/claude-sonnet-5", free: false, inputCost: 2 }),
      choice({ id: "abacus/claude-opus-5", free: false, inputCost: 5 }),
    ]);

    expect(candidates.map((c) => c.modelId)).toEqual([
      "route-llm-code-low",
      "deepseek-ai/DeepSeek-V4-Flash-0731",
    ]);
  });

  it("never admits Abacus's chat router, even flagged", () => {
    // route-llm short-circuits to a Flash model above 5000 tokens of context,
    // which a coding agent passes on its system prompt alone. Nothing makes
    // a router that answers "how can I help?" usable here.
    expect(
      openLlmCandidates([
        choice({
          id: "abacus/route-llm",
          free: false,
          inputCost: 0.1,
          poolEligible: true,
        }),
      ])
    ).toEqual([]);
  });

  // A model with no published price arrives from the catalog as cost zero,
  // exactly like a real free-tier one. `openrouter/auto` is the case that hurt:
  // it is a paid router, it read as free, and it 402ed on every pass through
  // the pool for a user whose whole reason for the pool was having no credits.
  it("keeps unpriced OpenRouter routers out of the free pool", () => {
    const candidates = openLlmCandidates([
      choice({ id: "openrouter/auto" }),
      choice({ id: "openrouter/openrouter/fusion" }),
      choice({ id: "openrouter/stealth/ox-alpha" }),
      choice({ id: "openrouter/z-ai/glm-5.2:free" }),
    ]);

    expect(candidates.map((c) => c.id)).toEqual([
      "openrouter/z-ai/glm-5.2:free",
    ]);
  });

  it("still pools every model OpenRouter marks :free", () => {
    const candidates = openLlmCandidates([
      choice({ id: "openrouter/google/gemma-4-31b-it:free" }),
      choice({ id: "openrouter/nvidia/nemotron-3-ultra-550b-a55b:free" }),
    ]);

    expect(candidates).toHaveLength(2);
  });

  // The suffix is necessary, not sufficient: a priced model is out regardless.
  it("does not pool a :free id that carries a price", () => {
    expect(
      openLlmCandidates([
        choice({ id: "openrouter/some/model:free", free: false, inputCost: 2 }),
      ])
    ).toEqual([]);
  });

  it("leaves paid providers and unknown custom endpoints out", () => {
    // A custom endpoint with zero registered cost is not necessarily free —
    // a LiteLLM proxy to a paid model registers the same way — so only the
    // sources known to be free are pooled.
    const candidates = openLlmCandidates([
      choice({ id: "anthropic/claude-opus-5", free: false, inputCost: 5 }),
      choice({
        id: "deepseek/deepseek-v4-flash",
        free: false,
        inputCost: 0.14,
      }),
      choice({ id: "myproxy/gpt-5.6-sol" }),
    ]);

    expect(candidates).toEqual([]);
  });

  it("orders the sources: cheap Abacus, Gemini, OpenRouter", () => {
    const candidates = openLlmCandidates([
      choice({
        id: "abacus/route-llm-code-low",
        free: false,
        inputCost: 0.22,
        poolEligible: true,
      }),
      choice({ id: "openrouter/deepseek/deepseek-chat-v3:free" }),
      choice({ id: "gemini/gemini-3.5-flash-lite", free: false }),
    ]);

    expect(candidates.map((c) => c.provider)).toEqual([
      "abacus",
      "gemini",
      "openrouter",
    ]);
  });

  it("ranks agent-capable families ahead of general chat, within OpenRouter", () => {
    const candidates = openLlmCandidates([
      choice({ id: "openrouter/some/chat-model:free" }),
      choice({ id: "openrouter/meta-llama/llama-4-scout:free" }),
      choice({ id: "openrouter/deepseek/deepseek-chat-v3:free" }),
      choice({ id: "openrouter/qwen/qwen3-coder:free" }),
    ]);

    expect(candidates.map((c) => c.modelId)).toEqual([
      "deepseek/deepseek-chat-v3:free",
      "qwen/qwen3-coder:free",
      "meta-llama/llama-4-scout:free",
      "some/chat-model:free",
    ]);
  });

  it("breaks family ties by context window — transcripts outgrow small ones", () => {
    const candidates = openLlmCandidates([
      choice({ id: "openrouter/deepseek/small:free", contextWindow: 32_000 }),
      choice({ id: "openrouter/deepseek/large:free", contextWindow: 164_000 }),
    ]);

    expect(candidates[0]?.modelId).toBe("deepseek/large:free");
  });

  it("orders unknown families stably, by label", () => {
    const a = choice({ id: "openrouter/z/a:free", label: "Alpha" });
    const z = choice({ id: "openrouter/a/z:free", label: "Zulu" });

    expect(openLlmCandidates([z, a]).map((c) => c.label)).toEqual([
      "Alpha",
      "Zulu",
    ]);
  });
});

describe("rotation across failures", () => {
  const candidates = openLlmCandidates([
    choice({ id: "openrouter/deepseek/one:free" }),
    choice({ id: "gemini/gemini-3.5-flash-lite", free: false }),
    choice({ id: "openrouter/z/two:free", label: "Zulu" }),
  ]);

  it("starts on the best-ranked candidate", () => {
    const rotation = new OpenLlmRotation(() => 0);

    expect(rotation.pick(candidates)?.id).toBe("gemini/gemini-3.5-flash-lite");
  });

  it("moves down the pool as models fail, ending on the last rung", () => {
    const rotation = new OpenLlmRotation(() => 0);

    rotation.markFailed("gemini/gemini-3.5-flash-lite");
    expect(rotation.pick(candidates)?.id).toBe("openrouter/deepseek/one:free");

    rotation.markFailed("openrouter/deepseek/one:free");
    expect(rotation.pick(candidates)?.id).toBe("openrouter/z/two:free");
  });

  it("skips the model that just failed even before it is marked", () => {
    // The rotation excludes the current model by id: marking happens a moment
    // later, and a pick that could return the model being rotated away from
    // would switch to the thing that just broke.
    const rotation = new OpenLlmRotation(() => 0);

    expect(
      rotation.pick(candidates, new Set(["gemini/gemini-3.5-flash-lite"]))?.id
    ).toBe("openrouter/deepseek/one:free");
  });

  it("lets a failed model back in once its cooldown expires", () => {
    let now = 0;
    const rotation = new OpenLlmRotation(() => now);

    rotation.markFailed("gemini/gemini-3.5-flash-lite");
    expect(rotation.pick(candidates)?.id).toBe("openrouter/deepseek/one:free");

    now = OPENLLM_COOLDOWN_MS + 1;
    expect(rotation.pick(candidates)?.id).toBe("gemini/gemini-3.5-flash-lite");
  });

  it("lengthens the wait as failures pile up, and caps it", () => {
    expect(cooldownForFailures(1)).toBe(OPENLLM_COOLDOWN_MS);
    expect(cooldownForFailures(2)).toBeGreaterThan(cooldownForFailures(1));
    expect(cooldownForFailures(3)).toBeGreaterThan(cooldownForFailures(2));
    // Capped, so a model that has been down for a week is still retried today.
    expect(cooldownForFailures(99)).toBe(cooldownForFailures(3));
    expect(cooldownForFailures(99)).toBe(60 * 60_000);
  });

  it("escalates the wait a model actually serves on repeated failures", () => {
    let now = 0;
    const rotation = new OpenLlmRotation(() => now);
    const id = "gemini/gemini-3.5-flash-lite";

    rotation.markFailed(id);
    now = OPENLLM_COOLDOWN_MS + 1;
    expect(rotation.pick(candidates)?.id).toBe(id);

    // Second failure: the first step is no longer enough to bring it back.
    rotation.markFailed(id);
    now += OPENLLM_COOLDOWN_MS + 1;
    expect(rotation.pick(candidates)?.id).not.toBe(id);

    now += OPENLLM_COOLDOWN_STEPS_MS[1] ?? 0;
    expect(rotation.pick(candidates)?.id).toBe(id);
  });

  it("wipes the record of a model that answers", () => {
    // Without this the count only climbs, and one bad hour would still be
    // serving hour-long cooldowns weeks later.
    let now = 0;
    const rotation = new OpenLlmRotation(() => now);
    const id = "gemini/gemini-3.5-flash-lite";

    rotation.markFailed(id);
    rotation.markFailed(id);
    rotation.markSucceeded(id);
    expect(rotation.pick(candidates)?.id).toBe(id);

    // Back to the first step, not the third.
    rotation.markFailed(id);
    now += OPENLLM_COOLDOWN_MS + 1;
    expect(rotation.pick(candidates)?.id).toBe(id);
  });

  it("starts a new session already knowing what the last one learned", () => {
    // The bug this whole file exists for: every chat is its own process, so
    // without a shared store each one rediscovers a dead model by failing.
    const entries: Record<string, { until: number; failures: number }> = {};
    const store = {
      read: () => ({ ...entries }),
      write: (written: Record<string, { until: number; failures: number }>) => {
        for (const [id, entry] of Object.entries(written)) entries[id] = entry;
      },
    };

    const first = new OpenLlmRotation(() => 0, store);
    first.markFailed("gemini/gemini-3.5-flash-lite");

    const second = new OpenLlmRotation(() => 0, store);

    expect(second.pick(candidates)?.id).toBe("openrouter/deepseek/one:free");
  });

  it("still answers when every candidate failed recently", () => {
    // "Everything is rate-limited" must degrade to "retry the one that
    // recovers soonest", never to "no model at all".
    let now = 0;
    const rotation = new OpenLlmRotation(() => now);

    rotation.markFailed("gemini/gemini-3.5-flash-lite");
    now = 1000;
    rotation.markFailed("openrouter/deepseek/one:free");
    now = 2000;
    rotation.markFailed("openrouter/z/two:free");

    expect(rotation.pick(candidates)?.id).toBe("gemini/gemini-3.5-flash-lite");
  });

  it("returns nothing only when there is nothing to return", () => {
    const rotation = new OpenLlmRotation(() => 0);

    expect(rotation.pick([])).toBeUndefined();
    expect(
      rotation.pick(
        [choice({ id: "openrouter/deepseek/one:free" })],
        new Set(["openrouter/deepseek/one:free"])
      )
    ).toBeUndefined();
  });
});

const DAY =
  "429: Rate limit exceeded: free-models-per-day. Add 10 credits to unlock 1000 free model requests per day";
const CREDIT =
  "402: Insufficient credits. This account never purchased credits. Make sure your key is on the correct account or org, and if so, purchase more at https://openrouter.ai/settings/credits";

describe("failures the account owns rather than the model", () => {
  it.each([
    ["the daily free quota", DAY, true],
    ["an empty balance", CREDIT, false],
  ])("reads %s as a whole tier", (_label, failure, free) => {
    expect(accountWideFailure(failure, "openrouter")).toEqual({
      provider: "openrouter",
      free,
    });
  });

  it.each([
    ["a plain rate limit", "429: Too many requests, slow down"],
    ["an overloaded model", "503: Model is overloaded"],
    ["a 402 that names no cause", "402: Payment required"],
  ])("leaves %s to the model that hit it", (_label, failure) => {
    expect(accountWideFailure(failure, "openrouter")).toBeNull();
  });

  it("reads an exhausted Abacus balance as every billed model's failure", () => {
    // RouteLLM's credit gate refuses each billed model the same way; the $0
    // preview is the one sibling it still serves, so only the paid tier closes.
    expect(
      accountWideFailure(
        "429: You have no remaining credits to use the LLM apis.",
        "abacus"
      )
    ).toEqual({ provider: "abacus", free: false });
    expect(accountWideFailure("503: Model is overloaded", "abacus")).toBeNull();
  });

  it("says nothing about providers that do not share an allowance", () => {
    // A Studio key's quota has nothing to do with OpenRouter's wording, and
    // matching on text alone would condemn it.
    expect(accountWideFailure(DAY, "gemini")).toBeNull();
    expect(accountWideFailure(DAY, undefined)).toBeNull();
  });

  it("reads a Studio key's spent quota as the whole key's failure", () => {
    // Google's wording for the free tier's daily allowance; a plain 429 is a
    // per-model rate limit and stays with the model.
    expect(
      accountWideFailure(
        '429: {"error":{"code":429,"message":"You exceeded your current quota, please check your plan and billing details.","status":"RESOURCE_EXHAUSTED"}}',
        "gemini"
      )
    ).toEqual({ provider: "gemini" });
    expect(
      accountWideFailure(
        "429: Resource has been exhausted (e.g. check quota).",
        "gemini"
      )
    ).toBeNull();
    expect(accountWideFailure("503: overloaded", "gemini")).toBeNull();
  });
});

describe("a pool whose account has closed a tier", () => {
  const pool = openLlmCandidates([
    choice({ id: "openrouter/z-ai/glm-5.2:free" }),
    choice({ id: "openrouter/google/gemma-4-31b-it:free" }),
    choice({ id: "openrouter/nvidia/nemotron-3.5:free" }),
    choice({ id: "gemini/gemini-3.5-flash-lite", free: false }),
  ]);

  it("steps over every sibling sharing the exhausted quota", () => {
    // The reported cascade: five free models tried, five identical 429s
    // printed, because the allowance belongs to the key and not the model.
    const rotation = new OpenLlmRotation(() => 0);

    rotation.markScopeFailed({ provider: "openrouter", free: true });

    expect(rotation.pick(pool)?.id).toBe("gemini/gemini-3.5-flash-lite");
  });

  it("knows a shut pool from a busy one", () => {
    // Busy: models cooling down still get a turn when the wait is shortest.
    // Shut: the account refused every class, and only a new source helps.
    const rotation = new OpenLlmRotation(() => 0);

    expect(rotation.poolShut(pool)).toBe(false);
    rotation.markFailed("openrouter/z-ai/glm-5.2:free");
    expect(rotation.poolShut(pool)).toBe(false);
    rotation.markScopeFailed({ provider: "openrouter", free: true });
    expect(rotation.poolShut(pool)).toBe(false);
    rotation.markScopeFailed({ provider: "gemini" });
    expect(rotation.poolShut(pool)).toBe(true);
    expect(rotation.poolShut([])).toBe(false);
  });

  it("has nothing to offer when the closed tier was the whole pool", () => {
    // And that is the point: no candidate means the turn ends on one error,
    // rather than rotating through siblings to collect the same one.
    const rotation = new OpenLlmRotation(() => 0);
    const freeOnly = pool.filter((model) => model.provider === "openrouter");

    rotation.markScopeFailed({ provider: "openrouter", free: true });

    expect(rotation.pick(freeOnly)).toBeUndefined();
  });

  it("hops an out-of-credits Abacus account straight to its $0 model", () => {
    const rotation = new OpenLlmRotation(() => 0);
    const abacus = openLlmCandidates([
      choice({
        id: "abacus/deepseek-ai/DeepSeek-V4-Flash-Vision-Exp",
        free: false,
        inputCost: 0.22,
        poolEligible: true,
      }),
      choice({
        id: "abacus/stealth/union-alpha",
        free: true,
        inputCost: 0,
        poolEligible: true,
      }),
    ]);

    rotation.markScopeFailed({ provider: "abacus", free: false });

    expect(rotation.pick(abacus)?.id).toBe("abacus/stealth/union-alpha");
  });

  it("keeps the paid tier, which is a different allowance", () => {
    const rotation = new OpenLlmRotation(() => 0);
    const paid = choice({ id: "openrouter/deepseek/paid", free: false });

    rotation.markScopeFailed({ provider: "openrouter", free: true });

    expect(rotation.pick([...pool, paid])?.id).toBe(
      "gemini/gemini-3.5-flash-lite"
    );
    expect(rotation.pick([paid])?.id).toBe("openrouter/deepseek/paid");
  });

  it("opens the tier again once the cooldown runs out", () => {
    let now = 0;
    const rotation = new OpenLlmRotation(() => now);

    // Gemini outranks OpenRouter, so it is set aside to watch the tier itself.
    const withoutGemini = new Set(["gemini/gemini-3.5-flash-lite"]);

    rotation.markScopeFailed({ provider: "openrouter", free: true });
    expect(rotation.pick(pool, withoutGemini)).toBeUndefined();

    now = OPENLLM_ACCOUNT_COOLDOWN_MS + 1;
    expect(rotation.pick(pool, withoutGemini)?.id).toBe(
      "openrouter/z-ai/glm-5.2:free"
    );
  });
});
