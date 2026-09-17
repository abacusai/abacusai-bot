/**
 * Model providers. AbacusAIBot is bring-your-own-model, and every shape is a pi
 * provider underneath: Anthropic or OpenAI by key or the OAuth pi stores,
 * OpenRouter including its `:free` tier, Gemini and Abacus registered here, and
 * any OpenAI-compatible endpoint declared in config as a custom provider. A
 * provider is usable the moment a credential exists for it.
 */
import * as fs from "node:fs";
import * as path from "node:path";

import {
  ModelRegistry,
  ModelRuntime,
  resolveCliModel,
} from "@earendil-works/pi-coding-agent";

import { abacusV1BaseUrl } from "./abacus-endpoint.js";
import type { AbacusBotConfig, CustomProviderConfig } from "./config.js";
import { missingCatalogSupplements } from "./model-catalog.js";

/** Providers AbacusAIBot surfaces by name, in the order the UI shows them. */
export const BUILTIN_PROVIDERS = [
  "abacus",
  "anthropic",
  "openai-codex",
  "openai",
  "gemini",
  "openrouter",
  "deepseek",
  // The long tail: providers pi drives with nothing but an API key, no
  // registration call. Listed so `listProviderStatus` reports them.
  "baseten",
  "cerebras",
  "fireworks",
  "groq",
  "huggingface",
  "minimax",
  "mistral",
  "moonshotai",
  "nvidia",
  "opencode",
  "together",
  "vercel-ai-gateway",
  "xai",
  "zai",
] as const;

export interface ModelChoice {
  /** Canonical `provider/model-id` reference — what `set_model` carries. */
  id: string;
  provider: string;
  modelId: string;
  label: string;
  /** True when the model bills at zero cost (OpenRouter's `:free` tier). */
  free: boolean;
  /** Input price in dollars per million tokens; 0 for free and local models. */
  inputCost: number;
  reasoning: boolean;
  contextWindow: number;
  /**
   * Abacus only: whether this model belongs in OpenLLM's free pool, and where
   * in the Abacus slice it is tried. Both come from the catalog's
   * `route-llm-open` entry (see abacusPool), so a stale openllm selection can
   * never route onto premium models.
   */
  poolEligible?: boolean;
  poolRank?: number;
}

export interface ProviderStatus {
  provider: string;
  displayName: string;
  /** A key or OAuth credential is present, so models under it can run. */
  configured: boolean;
  source?: string;
}

/**
 * Write the models pi's bundled catalog lacks as a models.json for it to load,
 * keeping the provider's own auth and transport. Rewritten on every start, so
 * a pi bump that carries a model natively leaves nothing stale behind.
 */
export function writeCatalogSupplement(agentDir: string): string {
  const providers = Object.fromEntries(
    Object.entries(missingCatalogSupplements()).map(([provider, models]) => [
      provider,
      { models },
    ])
  );
  const modelsPath = path.join(agentDir, "models-supplement.json");
  fs.mkdirSync(agentDir, { recursive: true });
  fs.writeFileSync(modelsPath, JSON.stringify({ providers }, null, 2));
  return modelsPath;
}

export async function createModelRuntime(
  agentDir: string
): Promise<ModelRuntime> {
  // Credentials and the model catalog live beside the rest of AbacusAIBot's
  // state rather than in pi's default `~/.pi/agent`, so an install never
  // clobbers a user's own pi setup.
  return ModelRuntime.create({
    authPath: path.join(agentDir, "auth.json"),
    modelsPath: writeCatalogSupplement(agentDir),
    modelsStorePath: path.join(agentDir, "models.json"),
    // Refresh catalogs at startup so OpenRouter's free tier reflects what is
    // actually free today, not whatever shipped with the build.
    allowModelNetwork: true,
  });
}

/**
 * Register the user's custom OpenAI-compatible endpoints with pi. Each becomes
 * a real provider, so its models flow through the same paths as the built-ins.
 */
export function registerCustomProviders(
  registry: ModelRegistry,
  config: AbacusBotConfig
): void {
  for (const provider of config.customProviders ?? []) {
    try {
      registry.registerProvider(provider.id, toProviderConfig(provider));
    } catch (error) {
      // pi validates on registration; letting the throw out would stop every
      // provider after this one and fail the session (or, on a model-pick
      // refresh, wedge the picker). A provider the user cannot use is worth a
      // line on stderr, not the other providers.
      process.stderr.write(
        `[abacusai-bot-agent] skipping custom provider ${provider.id}: ${
          error instanceof Error ? error.message : String(error)
        }\n`
      );
    }
  }
}

/**
 * Gemini, on pi's native Google transport. Google's OpenAI-compatible surface
 * looks simpler but cannot carry these models: it rejects the `store` field pi
 * sends, and Gemini 3 requires each tool call's `thought_signature` back on the
 * next request, which the OpenAI wire format has no place for. Registered only
 * when a key exists, so the list never offers a model that fails on token one.
 */
export function registerGeminiProvider(registry: ModelRegistry): void {
  const apiKey = (process.env.GEMINI_API_KEY ?? "").trim();

  if (apiKey.length === 0) return;

  const model = (
    id: string,
    name: string,
    cost: { input: number; output: number }
  ) => ({
    id,
    name,
    reasoning: true,
    input: ["text" as const],
    cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 1_048_576,
    maxTokens: 65_536,
    // Neither model can be told to stop thinking; `off: null` stops pi sending
    // an off level these reject.
    thinkingLevelMap: { off: null },
  });

  registry.registerProvider("gemini", {
    name: "Google Gemini",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    apiKey,
    api: "google-generative-ai" as const,
    // Ids and pricing per ai.google.dev/gemini-api/docs (checked 2026-08-13).
    models: [
      model("gemini-3.6-flash", "Gemini 3.6 Flash", {
        input: 1.5,
        output: 7.5,
      }),
      model("gemini-3.5-flash-lite", "Gemini 3.5 Flash-Lite", {
        input: 0.3,
        output: 2.5,
      }),
    ],
  });
}

/** The serving base, validated override or production; see abacus-endpoint. */
const abacusBaseUrl = (): string => abacusV1BaseUrl();

interface AbacusPiModel {
  id: string;
  name: string;
  reasoning: boolean;
  /** OpenLLM pool membership and order — see ModelChoice.poolEligible. */
  poolEligible?: boolean;
  poolRank?: number;
  /** The platform says it bills nothing; see AbacusCatalogEntry.free. */
  free?: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  compat: { supportsDeveloperRole: false };
}

interface AbacusCatalogEntry {
  id?: string;
  name?: string;
  display_name?: string;
  model_type?: string;
  input_modalities?: string[];
  output_modalities?: string[];
  context_length?: number;
  max_completion_tokens?: number;
  input_token_rate?: number | string;
  output_token_rate?: number | string;
  thinking?: boolean;
  /** Priced $0/$0 by the platform: bills nothing, and keeps serving once the balance is gone. */
  free?: boolean;
  /** `route-llm-open` only: the Abacus models the pool tries, in order. */
  pool?: string[];
}

const abacusModel = (
  id: string,
  name: string,
  cost: { input: number; output: number },
  contextWindow: number,
  maxTokens: number,
  reasoning = true,
  poolEligible = false,
  input: Array<"text" | "image"> = ["text"]
): AbacusPiModel => ({
  id,
  name,
  reasoning,
  input,
  cost: { ...cost, cacheRead: 0, cacheWrite: 0 },
  contextWindow,
  maxTokens,
  poolEligible,
  // pi sends a reasoning model's system prompt as role `developer`, which only
  // OpenAI's o-series takes; the hosts behind routellm (Together, Novita)
  // reject the whole request, so a picked Qwen or Kimi model failed every turn
  // with a 400. Every catalog model is reasoning, so say it once here.
  compat: { supportsDeveloperRole: false },
});

/**
 * The routers, which resolve to a different model per turn. `route-llm-code`
 * classifies each turn by complexity and `-low` is the same classifier on the
 * low-cost ladder. `route-llm` is the CHAT router and is kept out of the list
 * entirely: above 5000 tokens of context it short-circuits to a Flash model,
 * which a coding agent passes on its system prompt alone, so an agent driven by
 * it answers "how can I help?" instead of working.
 */
const CHAT_ROUTER_ID = "route-llm";
const CODE_ROUTER_ID = "route-llm-code";
const CODE_ROUTER_LOW_ID = "route-llm-code-low";
/**
 * Not a model: the catalog entry describing the Abacus slice of OpenLLM's
 * pool — which models, in which order — so that lives on the platform and
 * changes there without an app release.
 */
export const OPEN_POOL_ID = "route-llm-open";

/**
 * The Abacus pool the catalog declares, in order; null when the server
 * predates the descriptor, in which case the caller infers it from the tier.
 */
export const abacusPool = (
  entries: ReadonlyArray<{ id?: string; pool?: unknown }>
): string[] | null => {
  const descriptor = entries.find((entry) => entry.id === OPEN_POOL_ID);

  if (descriptor == null || !Array.isArray(descriptor.pool)) return null;

  return descriptor.pool.filter(
    (id): id is string => typeof id === "string" && id.length > 0
  );
};

/** Over plain Flash so a free-tier default can see attached images. */
export const FLASH_VISION_ID = "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp";

/** The drivers this app selects on its own, best first. */
export const ABACUS_PREFERRED_MODELS = [
  CODE_ROUTER_LOW_ID,
  CODE_ROUTER_ID,
  FLASH_VISION_ID,
];
/**
 * Enough of the catalog to work offline. Only a fallback: the live list is
 * per-account, so this is what a failed fetch leaves rather than the truth.
 */
const STATIC_ABACUS_MODELS: AbacusPiModel[] = [
  // First, so a fallback list picks the same driver the live catalog would.
  {
    ...abacusModel(
      CODE_ROUTER_LOW_ID,
      "RouteLLM (Code, Low)",
      { input: 0.14, output: 0.28 },
      1_000_000,
      64_000,
      true,
      true
    ),
    poolRank: 0,
  },
  abacusModel(
    CODE_ROUTER_ID,
    "RouteLLM (Code)",
    { input: 2, output: 10 },
    1_000_000,
    64_000
  ),
  abacusModel(
    "claude-sonnet-5",
    "Claude Sonnet 5",
    { input: 2, output: 10 },
    1_000_000,
    64_000
  ),
  abacusModel(
    "claude-opus-5",
    "Claude Opus 5",
    { input: 5, output: 25 },
    1_000_000,
    128_000
  ),
  abacusModel(
    "claude-haiku-4-5-20251001",
    "Claude Haiku 4.5",
    { input: 1, output: 5 },
    200_000,
    64_000
  ),
  abacusModel(
    "gpt-5.6-terra",
    "GPT-5.6 Terra",
    { input: 2, output: 12 },
    1_000_000,
    128_000
  ),
  abacusModel(
    "gemini-3.6-flash",
    "Gemini 3.6 Flash",
    { input: 1.5, output: 7.5 },
    1_048_576,
    65_536
  ),
  abacusModel("grok-4.6", "Grok 4.6", { input: 2, output: 6 }, 500_000, 32_768),
  abacusModel(
    "deepseek-ai/DeepSeek-V4-Pro",
    "DeepSeek V4 Pro",
    { input: 1.74, output: 3.48 },
    1_000_000,
    131_072
  ),
  abacusModel(
    FLASH_VISION_ID,
    "DeepSeek V4 Flash Vision",
    { input: 0.14, output: 0.28 },
    1_000_000,
    131_072,
    true,
    false,
    ["text", "image"]
  ),
  abacusModel(
    "deepseek-ai/DeepSeek-V4-Flash-0731",
    "DeepSeek V4 Flash",
    { input: 0.14, output: 0.28 },
    1_000_000,
    131_072
  ),
  abacusModel(
    "moonshotai/Kimi-K2.7-Code",
    "Kimi K2.7 Code",
    { input: 0.95, output: 4 },
    262_144,
    131_072
  ),
];

/**
 * Sort key putting the preferred drivers first: `getAvailable()[0]` is the
 * default a session lands on. Everything else keeps the catalog's own order.
 */
const abacusRank = (id: string): number => {
  const index = ABACUS_PREFERRED_MODELS.indexOf(id);

  return index === -1 ? ABACUS_PREFERRED_MODELS.length : index;
};

/** Per-token dollars in the catalog; pi wants per-million. */
const perMillion = (
  rate: number | string | undefined,
  fallback: number
): number => {
  const value = Number(rate ?? NaN) * 1_000_000;

  return Number.isFinite(value) && value > 0 ? value : fallback;
};

const fetchAbacusCatalog = async (apiKey: string): Promise<AbacusPiModel[]> => {
  try {
    const response = await fetch(`${abacusBaseUrl()}/models`, {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) return [];

    const body = (await response.json()) as { data?: AbacusCatalogEntry[] };

    // The pool is the catalog's `route-llm-open` list, in its order. A server
    // predating the descriptor gets the old inference: a free-tier catalog
    // never lists the standard code router, and there the CONCRETE models are
    // the pool (not the low router, so OpenLLM does not route into a router
    // that routes again); a paid catalog contributes only the low router.
    const pool = abacusPool(body.data ?? []);
    const freeTierCatalog = !(body.data ?? []).some(
      (entry) => entry.id === CODE_ROUTER_ID
    );
    const inferredPool = (id: string): boolean =>
      freeTierCatalog ? id !== CODE_ROUTER_LOW_ID : id === CODE_ROUTER_LOW_ID;

    return (body.data ?? [])
      .filter((entry): entry is AbacusCatalogEntry & { id: string } => {
        if (entry.id == null || entry.id.length === 0) return false;
        // Dropped so the chat router cannot be picked; see CHAT_ROUTER_ID.
        if (entry.id === CHAT_ROUTER_ID) return false;
        // Media models are driven by the generation tools, not the agent loop.
        if (entry.model_type != null && entry.model_type !== "text_generation")
          return false;

        return (
          entry.output_modalities == null ||
          entry.output_modalities.includes("text")
        );
      })
      .map((entry) => ({
        ...abacusModel(
          entry.id,
          entry.display_name ?? entry.name ?? entry.id,
          {
            input: perMillion(entry.input_token_rate, 0),
            output: perMillion(entry.output_token_rate, 0),
          },
          entry.context_length ?? 128_000,
          entry.max_completion_tokens ?? 8_192,
          entry.thinking !== false,
          pool != null ? pool.includes(entry.id) : inferredPool(entry.id),
          // What the platform says the model can SEE; registered text-only, the
          // harness strips attached images before the provider sees them.
          entry.input_modalities?.includes("image")
            ? ["text", "image"]
            : ["text"]
        ),
        ...(pool != null && pool.includes(entry.id)
          ? { poolRank: pool.indexOf(entry.id) }
          : {}),
        // The platform's word, not a price test: an entry with no rate arrives
        // as cost zero, which is not the same as free.
        free: entry.free === true,
      }))
      .sort((a, b) => abacusRank(a.id) - abacusRank(b.id));
  } catch {
    // Offline or an unrecognised shape: the static list still stands.
    return [];
  }
};

/**
 * Abacus.AI, gated on a key like Gemini but with its model list FETCHED: the
 * desktop picker offers every model `/v1/models` returns, and pi can only run
 * a model registered here, so the two have to come from the same source.
 */
export async function registerAbacusProvider(
  registry: ModelRegistry
): Promise<void> {
  const apiKey = (process.env.ABACUS_API_KEY ?? "").trim();

  if (apiKey.length === 0) return;

  const live = await fetchAbacusCatalog(apiKey);

  registry.registerProvider("abacus", {
    name: "Abacus.AI",
    baseUrl: abacusBaseUrl(),
    apiKey,
    api: "openai-completions" as const,
    models: live.length > 0 ? live : STATIC_ABACUS_MODELS,
  });
}

function toProviderConfig(provider: CustomProviderConfig) {
  return {
    name: provider.name ?? provider.id,
    baseUrl: provider.baseUrl,
    ...(provider.apiKey ? { apiKey: provider.apiKey } : {}),
    api: "openai-completions" as const,
    ...(provider.headers ? { headers: provider.headers } : {}),
    models: (provider.models ?? []).map((model) => ({
      id: model.id,
      name: model.name ?? model.id,
      reasoning: model.reasoning ?? false,
      input: ["text" as const],
      // No billing meter on a self-hosted endpoint; zero cost is accurate and
      // marks these "free" in the picker.
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: model.contextWindow ?? 128_000,
      maxTokens: model.maxTokens ?? 8_192,
    })),
  };
}

export function listProviderStatus(
  registry: ModelRegistry,
  config: AbacusBotConfig
): ProviderStatus[] {
  const ids = [
    ...BUILTIN_PROVIDERS,
    ...(config.customProviders ?? []).map((provider) => provider.id),
  ];

  return ids.map((provider) => {
    const status = registry.getProviderAuthStatus(provider);

    return {
      provider,
      displayName: registry.getProviderDisplayName(provider) || provider,
      configured: status?.configured ?? false,
      ...(status?.source ? { source: status.source } : {}),
    };
  });
}

/**
 * Every model the user can run right now: `getAvailable()` is scoped to
 * providers with working credentials.
 */
export function listModels(registry: ModelRegistry): ModelChoice[] {
  return registry.getAvailable().map(toChoice);
}

/** The zero-cost slice of the catalog: OpenRouter's free tier plus local. */
export function listFreeModels(registry: ModelRegistry): ModelChoice[] {
  return listModels(registry).filter((model) => model.free);
}

function toChoice(
  model: ReturnType<ModelRegistry["getAvailable"]>[number]
): ModelChoice {
  const cost = model.cost as { input?: number; output?: number } | undefined;
  const flags = model as {
    free?: boolean;
    poolEligible?: boolean;
    poolRank?: number;
  };
  // A provider that states free-ness (Abacus) is believed over the price line.
  const free =
    flags.free ?? ((cost?.input ?? 0) === 0 && (cost?.output ?? 0) === 0);

  return {
    id: `${model.provider}/${model.id}`,
    provider: model.provider,
    modelId: model.id,
    label: model.name ?? model.id,
    free,
    inputCost: cost?.input ?? 0,
    reasoning: Boolean(model.reasoning),
    contextWindow: model.contextWindow ?? 0,
    poolEligible: flags.poolEligible,
    poolRank: flags.poolRank,
  };
}

/**
 * How many output tokens a request asks for at most, unless config says more.
 * Providers that check credit before running price the ceiling you authorised:
 * OpenRouter multiplies `maxTokens` by the output rate and refuses with a 402
 * when the key cannot cover it, so a model declaring 384,000 output tokens
 * turns a key holding a few cents into a dead one. 32,768 is far more than a
 * coding turn emits; a model asking for less keeps its own number.
 */
export const DEFAULT_MAX_OUTPUT_TOKENS = 32_768;

/**
 * The model, with its output budget brought under `ceiling`. A copy, because
 * the model belongs to pi's registry and is shared by every session.
 */
function withOutputBudget<T extends { maxTokens?: number }>(
  model: T,
  ceiling: number
): T {
  if (!(ceiling > 0)) return model;

  const declared = model.maxTokens;

  if (declared == null || declared <= ceiling) return model;

  return { ...model, maxTokens: ceiling };
}

/**
 * Resolve what the desktop sent (`set_model`, or `--model` at spawn) to a pi
 * model, with the pi CLI's own fuzzy matching. Every path that turns a
 * reference into a model comes through here, so it is the one place the output
 * budget is capped.
 */
export function resolveModel(
  modelRuntime: ModelRuntime,
  reference: string | undefined,
  maxOutputTokens: number = DEFAULT_MAX_OUTPUT_TOKENS
) {
  if (!reference) {
    return { model: undefined, error: undefined, warning: undefined };
  }

  const resolved = resolveCliModel({ cliModel: reference, modelRuntime });

  return resolved.model == null
    ? resolved
    : { ...resolved, model: withOutputBudget(resolved.model, maxOutputTokens) };
}
