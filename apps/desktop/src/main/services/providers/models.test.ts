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
/** Each provider's public /v1/models; a missing entry does not answer. */
const liveLists = new Map<string, string[]>();

vi.mock("../config/settings", () => ({
  credentialFor: (name: string) =>
    credentials.current.has(name) ? "test-key" : "",
  hasCredential: (name: string) => credentials.current.has(name),
  hasOAuthCredential: () => false,
}));
const abacus = vi.hoisted(() => ({
  tier: null as string | null,
  live: [] as Array<Record<string, unknown>>,
  refused: new Set<string>(),
  unlockPlan: null as string | null,
  topModels: undefined as
    | Array<{ id: string; name: string; agentic?: boolean }>
    | undefined,
}));

vi.mock("./abacus", () => ({
  abacusPaymentRequired: () => null,
  cachedAbacusModels: () => abacus.live,
  clearAbacusCache: () => {},
  fetchAbacusAccount: async () =>
    abacus.tier == null ? null : { subscription_tier: abacus.tier },
  fetchAbacusModels: async () => abacus.live,
  planLockedAbacusIds: () => abacus.refused,
}));
vi.mock("./abacus-upgrade", () => ({
  fetchBillingPlan: async () =>
    abacus.unlockPlan == null
      ? null
      : {
          upgrades: [{ planName: abacus.unlockPlan }],
          topModels: abacus.topModels,
        },
}));
vi.mock("./openrouter", () => ({
  cachedFreeOpenRouterModels: () => [],
  clearOpenRouterCache: () => {},
  fetchFreeOpenRouterModels: async () => [],
}));
vi.mock("../../paths", () => ({ abacusBotHome: () => "/nonexistent-home" }));

vi.stubGlobal("fetch", async (url: string) => {
  const host = new URL(url).hostname;
  const ids = [...liveLists].find(([provider]) => host.includes(provider))?.[1];
  return ids == null
    ? new Response("unavailable", { status: 503 })
    : Response.json({ data: ids.map((id) => ({ id, object: "model" })) });
});

const { clearLiveModelIds } = await import("@abacus-ai/agent/model-catalog");
const { listAvailableModels, modelForTier } = await import("./models");

const forProvider = (
  models: Awaited<ReturnType<typeof listAvailableModels>>,
  provider: string
) => models.filter((model) => model.provider === provider);

beforeEach(() => {
  credentials.current = new Set();
  liveLists.clear();
  clearLiveModelIds();
  abacus.tier = null;
  abacus.live = [];
  abacus.refused = new Set();
  abacus.unlockPlan = null;
  abacus.topModels = undefined;
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
    // Ids stay `provider/model-id`, which is what set_model sends.
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

describe("a Groq model the provider has retired", () => {
  // pi's data still lists the Llama 3.x line; Groq answers each with a 404.
  const retired = "groq/llama-3.3-70b-versatile";

  it("is dropped when the live list does not carry it", async () => {
    credentials.current = new Set(["GROQ_API_KEY"]);
    liveLists.set("groq", ["openai/gpt-oss-120b", "openai/gpt-oss-20b"]);
    const groq = forProvider(await listAvailableModels(), "groq");

    expect(groq.map((model) => model.id)).not.toContain(retired);
    expect(groq.map((model) => model.id)).toContain("groq/openai/gpt-oss-120b");
    expect(groq.every((model) => model.configured)).toBe(true);
  });

  it("stays when the live list did not answer", async () => {
    credentials.current = new Set(["GROQ_API_KEY"]);
    const groq = forProvider(await listAvailableModels(), "groq");

    // Offline is not evidence of retirement; the catalog stands as it is.
    expect(groq.map((model) => model.id)).toContain(retired);
  });

  it("is not consulted for another provider's rows", async () => {
    credentials.current = new Set(["GROQ_API_KEY", "OPENAI_API_KEY"]);
    liveLists.set("groq", ["openai/gpt-oss-120b"]);
    const models = await listAvailableModels();

    expect(forProvider(models, "openai").length).toBeGreaterThan(10);
  });
});

describe("an NVIDIA model the provider has retired", () => {
  // NVIDIA retired both; Kimi K3 is in pi's data, GLM-5.3 was a supplement.
  const retired = ["nvidia/moonshotai/kimi-k3", "nvidia/z-ai/glm-5.3"];

  it("is dropped when NVIDIA's public list does not carry it", async () => {
    credentials.current = new Set(["NVIDIA_API_KEY"]);
    liveLists.set("nvidia", [
      "moonshotai/kimi-k2.6",
      "deepseek-ai/deepseek-v4.1-flash",
      "nvidia/nemotron-3-super-120b-a12b",
    ]);
    const ids = forProvider(await listAvailableModels(), "nvidia").map(
      (model) => model.id
    );

    for (const id of retired) expect(ids).not.toContain(id);
    expect(ids).toContain("nvidia/moonshotai/kimi-k2.6");
    expect(ids).toContain("nvidia/deepseek-ai/deepseek-v4.1-flash");
  });

  it("stays when the list did not answer", async () => {
    credentials.current = new Set(["NVIDIA_API_KEY"]);
    const ids = forProvider(await listAvailableModels(), "nvidia").map(
      (model) => model.id
    );

    expect(ids).toContain("nvidia/moonshotai/kimi-k3");
  });
});

describe("RouteLLM - Open", () => {
  // Any key the pool can draw on makes it runnable, not only the first two.
  it.each([
    "MISTRAL_API_KEY",
    "NVIDIA_API_KEY",
    "CEREBRAS_API_KEY",
    "GROQ_API_KEY",
  ])("is usable with nothing but %s", async (key) => {
    credentials.current = new Set([key]);
    const pool = (await listAvailableModels()).find(
      (model) => model.provider === "openllm"
    );

    expect(pool?.configured).toBe(true);
  });

  it("is not usable with no source at all", async () => {
    credentials.current = new Set(["ANTHROPIC_API_KEY"]);
    const pool = (await listAvailableModels()).find(
      (model) => model.provider === "openllm"
    );

    expect(pool?.configured).toBe(false);
  });
});

describe("what a free Abacus.AI plan can run", () => {
  // The audit: a free key was offered a paid model, and every turn on it
  // came back refused. The account's own /v1/models is what it can run.
  const liveFree = (id: string) => ({
    id,
    label: id,
    provider: "abacus",
    tier: "free",
    requiresEnv: "ABACUS_API_KEY",
    configured: true,
  });

  beforeEach(() => {
    credentials.current = new Set(["ABACUS_API_KEY"]);
    abacus.tier = "free";
    abacus.live = [liveFree("abacus/deepseek-v4.1-flash")];
    abacus.unlockPlan = "Basic";
  });

  it("locks the paid catalog behind the plan that includes it", async () => {
    const models = await listAvailableModels(true);
    const sonnet = models.find((m) => m.id === "abacus/claude-sonnet-5-5");

    expect(sonnet).toMatchObject({
      configured: false,
      access: "locked",
      unlockPlan: "Basic",
    });
    expect(
      models.find((m) => m.id === "abacus/deepseek-v4.1-flash")
    ).toMatchObject({ configured: true, access: "runnable" });
  });

  it("locks the plan's own top models, by the ids its billing plan names, over the static rows", async () => {
    abacus.topModels = [
      { id: "gpt-6.1-sol", name: "GPT-6.1 Sol", agentic: true },
      { id: "claude-opus-5-5", name: "Claude Opus 5.5", agentic: true },
      { id: "gemini-3.8-flash", name: "Gemini 3.8 Flash", agentic: false },
    ];
    const locked = (await listAvailableModels(true)).filter(
      (m) => m.access === "locked"
    );

    expect(locked.map((m) => [m.id, m.label, m.unlockPlan])).toEqual([
      ["abacus/gpt-6.1-sol", "GPT-6.1 Sol", "Basic"],
      ["abacus/claude-opus-5-5", "Claude Opus 5.5", "Basic"],
    ]);
  });

  it("marks a model with no key as needing one, not locked", async () => {
    const models = await listAvailableModels(true);

    expect(
      models.find((m) => m.id === "anthropic/claude-opus-5")
    ).toMatchObject({ configured: false, access: "needs-key" });
  });

  it("keeps a model the platform refused locked, even when a list names it", async () => {
    abacus.live = [
      liveFree("abacus/deepseek-v4.1-flash"),
      liveFree("abacus/some-paid-model"),
    ];
    abacus.refused = new Set(["abacus/some-paid-model", "abacus/gone-model"]);
    const models = await listAvailableModels(true);

    expect(models.find((m) => m.id === "abacus/some-paid-model")).toMatchObject(
      { configured: false, access: "locked" }
    );
    // A refused id no list carries still shows, locked, so nothing resolves to it.
    expect(models.find((m) => m.id === "abacus/gone-model")).toMatchObject({
      configured: false,
      access: "locked",
      label: "gone-model",
    });
  });

  it("says no plan when the platform offers none", async () => {
    abacus.unlockPlan = null;
    const sonnet = (await listAvailableModels(true)).find(
      (m) => m.id === "abacus/claude-sonnet-5-5"
    );

    expect(sonnet?.access).toBe("locked");
    expect(sonnet?.unlockPlan).toBeUndefined();
  });

  it("does not lock the paid catalog for a paying plan", async () => {
    abacus.tier = "pro";
    abacus.live = [{ ...liveFree("abacus/route-llm-code"), tier: "default" }];
    const models = await listAvailableModels(true);

    expect(models.some((m) => m.access === "locked")).toBe(false);
  });
});

describe("a pin once the plan is paid", () => {
  it.each([
    // The free plan's default moves to the paid tier's router.
    ["basic", "openllm/auto", "abacus/route-llm-code-low"],
    ["go", "openllm/auto", "abacus/route-llm-code-low"],
    ["pro", "openllm/auto", "abacus/route-llm-code"],
    ["max", "openllm/auto", "abacus/route-llm-code"],
    // Nothing else moves: a model the user chose, or the free plan itself.
    ["basic", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4-flash"],
    ["pro", "abacus/route-llm-code-low", "abacus/route-llm-code-low"],
    ["free", "openllm/auto", "openllm/auto"],
    [null, "openllm/auto", "openllm/auto"],
  ])("on %s, %s runs as %s", (tier, pin, expected) => {
    expect(modelForTier(tier, pin)).toBe(expected);
  });

  it("is never on a model the paid catalog drops", async () => {
    credentials.current = new Set(["ABACUS_API_KEY"]);
    abacus.tier = "basic";
    abacus.live = [
      {
        id: "abacus/route-llm-code-low",
        label: "RouteLLM",
        provider: "abacus",
        tier: "default",
        requiresEnv: "ABACUS_API_KEY",
        configured: true,
      },
    ];
    const ids = (await listAvailableModels(true)).map((m) => m.id);

    expect(ids).not.toContain("openllm/auto");
    expect(ids).toContain(modelForTier("basic", "openllm/auto"));
  });
});
