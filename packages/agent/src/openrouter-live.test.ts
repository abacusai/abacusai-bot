/**
 * The bundled OpenRouter snapshot cannot say which models take tools; the
 * live catalog can. Until it has answered the pool behaves as before, and
 * afterwards a model it names without tools, or does not name at all, is
 * out of the pool.
 */
import { afterEach, describe, expect, it } from "vitest";

import { openLlmCandidates } from "./openllm.js";
import {
  openRouterTakesTools,
  refreshOpenRouterLive,
  resetOpenRouterLiveForTesting,
  supportsTools,
} from "./openrouter-live.js";
import type { ModelChoice } from "./providers.js";

const choice = (modelId: string): ModelChoice => ({
  id: `openrouter/${modelId}`,
  provider: "openrouter",
  modelId,
  label: modelId,
  free: true,
  inputCost: 0,
  reasoning: false,
  contextWindow: 100_000,
});

const catalog = (
  entries: Array<{ id: string; supported_parameters?: string[] }>
): typeof fetch =>
  (async () => ({
    ok: true,
    json: async () => ({ data: entries }),
  })) as unknown as typeof fetch;

afterEach(() => {
  resetOpenRouterLiveForTesting();
});

describe("tool support from the live catalog", () => {
  it("reads it off the entry, and assumes it on an entry without the field", () => {
    expect(supportsTools({ supported_parameters: ["tools"] })).toBe(true);
    expect(supportsTools({ supported_parameters: ["max_tokens"] })).toBe(false);
    expect(supportsTools({})).toBe(true);
  });

  it("keeps the pool as it was until the catalog has answered", () => {
    expect(openRouterTakesTools("google/lyria-3-pro-preview")).toBe(true);
    expect(
      openLlmCandidates([choice("google/lyria-3-pro-preview:free")])
    ).toHaveLength(1);
  });

  it("drops a model the catalog says takes no tools, or no longer lists", async () => {
    await refreshOpenRouterLive(
      "key",
      catalog([
        { id: "google/gemma-4-31b-it:free", supported_parameters: ["tools"] },
        { id: "z-ai/glm-5.2:free", supported_parameters: ["max_tokens"] },
      ])
    );

    const ids = openLlmCandidates([
      choice("google/gemma-4-31b-it:free"),
      choice("z-ai/glm-5.2:free"),
      choice("minimax/minimax-m3:free"),
    ]).map((entry) => entry.modelId);

    expect(ids).toEqual(["google/gemma-4-31b-it:free"]);
  });

  it("does nothing without a key, and shrugs off a failed fetch", async () => {
    await refreshOpenRouterLive("");
    expect(openRouterTakesTools("anything")).toBe(true);

    const failing = (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch;
    await refreshOpenRouterLive("key", failing);
    expect(openRouterTakesTools("anything")).toBe(true);
  });
});
