/**
 * OpenRouter's free tier is not all chat models: a music model is priced at
 * zero and outputs text beside its audio, so the price and modality tests let
 * it into the picker, and every turn on it failed with "No endpoints found
 * that support tool use". The catalog says which models take tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../config/settings", () => ({
  hasCredential: () => true,
  readSettings: () => ({ apiKeys: { OPENROUTER_API_KEY: "key" } }),
}));

const entry = (
  id: string,
  extra: Record<string, unknown> = {}
): Record<string, unknown> => ({
  id,
  name: id,
  pricing: { prompt: "0", completion: "0" },
  architecture: { output_modalities: ["text"] },
  supported_parameters: ["tools", "max_tokens"],
  ...extra,
});

const catalog = [
  entry("google/gemma-4-31b-it:free"),
  entry("google/lyria-3-pro-preview", {
    architecture: { output_modalities: ["text", "audio"] },
    supported_parameters: ["max_tokens"],
  }),
  entry("z-ai/glm-5.2:free", { supported_parameters: ["max_tokens"] }),
  entry("old/entry:free", { supported_parameters: undefined }),
  entry("paid/model", { pricing: { prompt: "0.001", completion: "0.002" } }),
];

beforeEach(() => {
  vi.resetModules();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => ({ data: catalog }) }))
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("the free OpenRouter list", () => {
  it("keeps only free models that take tools, and forgives an old entry", async () => {
    const { fetchFreeOpenRouterModels } = await import("./openrouter");

    const ids = (await fetchFreeOpenRouterModels()).map((model) => model.id);

    expect(ids).toEqual([
      "openrouter/google/gemma-4-31b-it:free",
      "openrouter/old/entry:free",
    ]);
  });
});
