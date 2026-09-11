/**
 * What the picker offers for a key the user brought.
 *
 * The report: an OpenAI key was worth 2 models in the app and far more on
 * the CLI. The app's list was this file's hand-written catalog; the CLI's
 * was pi's. They read the same catalog now, so a provider's key is worth
 * every model pi can actually run with it.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const credentials = vi.hoisted(() => ({ current: new Set<string>() }));

vi.mock("../config/settings", () => ({
  hasCredential: (name: string) => credentials.current.has(name),
  hasOAuthCredential: () => false,
}));
vi.mock("./abacus", () => ({
  cachedAbacusModels: () => [],
  clearAbacusCache: () => {},
  fetchAbacusAccount: async () => null,
  fetchAbacusModels: async () => [],
}));
vi.mock("./openrouter", () => ({
  cachedFreeOpenRouterModels: () => [],
  clearOpenRouterCache: () => {},
  fetchFreeOpenRouterModels: async () => [],
}));
vi.mock("./ollama-service", () => ({
  ensureManagedOllamaServer: async () => {},
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent-home" }));

const { listAvailableModels } = await import("./models");

const forProvider = (
  models: Awaited<ReturnType<typeof listAvailableModels>>,
  provider: string
) => models.filter((model) => model.provider === provider);

beforeEach(() => {
  credentials.current = new Set();
});

describe("a provider the user has a key for", () => {
  it("offers everything pi can run with it, not the curated pair", async () => {
    const before = forProvider(await listAvailableModels(), "openai");
    // Without a key the curated rows still advertise the provider.
    expect(before.length).toBeGreaterThan(0);
    expect(before.every((model) => !model.configured)).toBe(true);

    credentials.current = new Set(["OPENAI_API_KEY"]);
    const after = forProvider(await listAvailableModels(), "openai");

    // The number is pi's, not ours; what matters is that it is no longer the
    // handful this file used to hold, and that every row is runnable.
    expect(after.length).toBeGreaterThan(before.length);
    expect(after.length).toBeGreaterThan(10);
    expect(after.every((model) => model.configured)).toBe(true);
    // Ids stay `provider/model-id` — what set_model sends.
    expect(after.every((model) => model.id.startsWith("openai/"))).toBe(true);
    // No duplicates when a curated row and a catalog row are the same model.
    expect(new Set(after.map((model) => model.id)).size).toBe(after.length);
  });

  it("offers a model newer than the bundled catalog once the key is in", async () => {
    credentials.current = new Set(["ANTHROPIC_API_KEY"]);
    const anthropic = forProvider(await listAvailableModels(), "anthropic");
    const fable = anthropic.filter(
      (m) => m.id === "anthropic/claude-fable-5-1"
    );

    expect(fable).toHaveLength(1);
    expect(fable[0]?.label).toBe("Claude Fable 5.1");
    expect(fable[0]?.configured).toBe(true);
  });

  it("leaves a provider with no key exactly as it was", async () => {
    credentials.current = new Set(["OPENAI_API_KEY"]);
    const models = await listAvailableModels();

    expect(forProvider(models, "anthropic").every((m) => !m.configured)).toBe(
      true
    );
    expect(forProvider(models, "anthropic").length).toBeLessThan(5);
  });

  it("keeps the curated label for a model that has one", async () => {
    const curated = forProvider(await listAvailableModels(), "openai");
    credentials.current = new Set(["OPENAI_API_KEY"]);
    const expanded = forProvider(await listAvailableModels(), "openai");

    for (const model of curated) {
      const same = expanded.find((entry) => entry.id === model.id);
      if (same != null) expect(same.label).toBe(model.label);
    }
  });

  // gemini and abacus are registered by the agent itself, so pi's catalog has
  // nothing for them: expanding from it would offer models that cannot resolve.
  it("does not touch the providers the agent registers itself", async () => {
    credentials.current = new Set(["GEMINI_API_KEY", "ABACUS_API_KEY"]);
    const models = await listAvailableModels();

    expect(forProvider(models, "gemini").length).toBeLessThan(5);
    expect(forProvider(models, "gemini").every((m) => m.configured)).toBe(true);
  });
});
