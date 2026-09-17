/**
 * The catalog rules OpenLLM depends on.
 *
 * The entry is data, but two facts about it are load-bearing and easy to break
 * from a distance: its id must match OPENLLM_ID in
 * packages/agent/src/openllm.ts (the agent intercepts exactly this string
 * before pi's resolver sees it), and its tier must not be "free" — the live
 * OpenRouter catalog supersedes hardcoded free-tier entries in
 * main/services/providers/models.ts, and the router is not a model the live
 * list carries, so tier "free" would silently drop it the moment a key was
 * added. Which is the exact moment it is supposed to appear.
 */
import { describe, expect, it } from "vitest";

import { MODEL_CATALOG, TIER_ORDER } from "./models";

const router = MODEL_CATALOG.find((model) => model.id === "openllm/auto");

describe("the OpenLLM catalog entry", () => {
  it("is named for the routing it does, not for the id it carries", () => {
    const entry = MODEL_CATALOG.find((model) => model.id === "openllm/auto");

    // The label is the only part users read. "OpenLLM" read as a different
    // product from the RouteLLM rows beside it; the id is untouched because
    // the agent resolves it and sessions have it stored.
    expect(entry?.label).toBe("RouteLLM - Open");
    expect(entry?.id).toBe("openllm/auto");
  });

  it("exists under the id the agent intercepts", () => {
    expect(router).toBeDefined();
    expect(router?.provider).toBe("openllm");
  });

  it("sits in the default tier, at the top of the picker", () => {
    // "Recommended" is the group the picker renders first; this is what makes
    // OpenLLM the top offer once any free source exists.
    expect(router?.tier).toBe("default");
    expect(TIER_ORDER[0]).toBe("default");
  });

  it("is never tier 'free', or the live catalog would supersede it away", () => {
    expect(router?.tier).not.toBe("free");
  });

  it("names OpenRouter as the primary way in", () => {
    // `requiresEnv` can only carry one variable; the availability service
    // widens `configured` to any pool source (Gemini or Abacus key)
    // — see openLlmConfigured in main/services/providers/models.ts.
    expect(router?.requiresEnv).toBe("OPENROUTER_API_KEY");
  });

  it("leads the catalog, with the low code router directly under it", () => {
    // Order within a tier is the order shown, so the Recommended group opens
    // with the routed defaults: the free pool, then the cheap Abacus router.
    expect(MODEL_CATALOG[0]?.id).toBe("openllm/auto");
    expect(MODEL_CATALOG[1]?.id).toBe("abacus/route-llm-code-low");
    expect(MODEL_CATALOG[1]?.label).toBe("RouteLLM");
    expect(MODEL_CATALOG[1]?.tier).toBe("default");
  });
});

describe("the RouteLLM catalog entry", () => {
  const cheap = MODEL_CATALOG.find(
    (model) => model.id === "abacus/route-llm-code-low"
  );

  it("names the CODE router, never the chat router", () => {
    // abacus/route-llm short-circuits to a Flash model above 5000 tokens of
    // context — the live catalog refuses to offer it, and the static list
    // must not resurrect it when the fetch fails.
    expect(cheap).toBeDefined();
    expect(MODEL_CATALOG.some((model) => model.id === "abacus/route-llm")).toBe(
      false
    );
  });

  it("is gated on the Abacus key it runs with", () => {
    expect(cheap?.requiresEnv).toBe("ABACUS_API_KEY");
    expect(cheap?.provider).toBe("abacus");
  });
});

describe("the expanded list's order", () => {
  it("puts free and cheap above the premium tiers", () => {
    // "More models" unfolds into what costs nothing (or nearly nothing) to
    // try; the premium models are a deliberate reach below, not the first
    // thing on offer.
    expect(TIER_ORDER.indexOf("free")).toBeLessThan(
      TIER_ORDER.indexOf("strong")
    );
    expect(TIER_ORDER.indexOf("fast")).toBeLessThan(
      TIER_ORDER.indexOf("strong")
    );
  });
});

/**
 * The other half of the pair with CURATED_MODEL_IDS in
 * packages/agent/src/providers.catalog.integration.test.ts, which resolves
 * each of these against pi's bundled catalog. The agent cannot import this
 * module, so the list is copied there; this test is what makes the copy honest
 * — add an entry here and the agent-side list has to grow with it.
 */
const PINNED_AGAINST_PI = [
  "anthropic/claude-haiku-4-5",
  "anthropic/claude-opus-5",
  "anthropic/claude-sonnet-5",
  "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
  "cerebras/gpt-oss-120b",
  "deepseek/deepseek-v4-flash",
  "deepseek/deepseek-v4-pro",
  "fireworks/accounts/fireworks/models/deepseek-v4-flash",
  "groq/openai/gpt-oss-120b",
  "huggingface/deepseek-ai/DeepSeek-V4-Flash",
  "minimax/MiniMax-M3",
  "mistral/devstral-medium-latest",
  "mistral/mistral-large-latest",
  "moonshotai/kimi-k2.7-code",
  "moonshotai/kimi-k3",
  "nvidia/nvidia/nemotron-3-super-120b-a12b",
  "openai/gpt-5.6-luna",
  "openai/gpt-5.6-sol",
  "opencode/deepseek-v4-flash",
  "openrouter/google/gemma-4-31b-it:free",
  "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
  "openrouter/openai/gpt-oss-20b:free",
  "together/deepseek-ai/DeepSeek-V4-Flash-0731",
  "vercel-ai-gateway/anthropic/claude-sonnet-5",
  "xai/grok-4.6",
  "xai/grok-build-0.1",
  "zai/glm-5.2",
];

// Registered through their own path rather than pi's env discovery, or (in
// OpenLLM's case) resolved by this app before pi ever sees the id.
const SELF_REGISTERED = ["openllm", "abacus", "gemini", "openai-codex"];

describe("the curated ids the agent test pins", () => {
  it("covers every entry pi is expected to resolve", () => {
    const expected = MODEL_CATALOG.filter(
      (model) => !SELF_REGISTERED.includes(model.provider)
    ).map((model) => model.id);

    expect([...expected].sort()).toEqual([...PINNED_AGAINST_PI].sort());
  });
});
