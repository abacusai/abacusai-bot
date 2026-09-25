/**
 * The models each built-in provider carries, from pi's bundled catalog. Only
 * pi's generated data modules are imported: this is bundled into the Electron
 * main process, which cannot load the agent's native dependencies. Providers
 * the agent registers itself (`gemini`, `abacus`, custom endpoints) are absent;
 * their lists live in providers.ts and are fetched live.
 */
import * as anthropic from "@earendil-works/pi-ai/providers/anthropic.models";
import * as baseten from "@earendil-works/pi-ai/providers/baseten.models";
import * as cerebras from "@earendil-works/pi-ai/providers/cerebras.models";
import * as deepseek from "@earendil-works/pi-ai/providers/deepseek.models";
import * as fireworks from "@earendil-works/pi-ai/providers/fireworks.models";
import * as groq from "@earendil-works/pi-ai/providers/groq.models";
import * as huggingface from "@earendil-works/pi-ai/providers/huggingface.models";
import * as minimax from "@earendil-works/pi-ai/providers/minimax.models";
import * as mistral from "@earendil-works/pi-ai/providers/mistral.models";
import * as moonshotai from "@earendil-works/pi-ai/providers/moonshotai.models";
import * as nvidia from "@earendil-works/pi-ai/providers/nvidia.models";
import * as openaiCodex from "@earendil-works/pi-ai/providers/openai-codex.models";
import * as openai from "@earendil-works/pi-ai/providers/openai.models";
import * as opencode from "@earendil-works/pi-ai/providers/opencode.models";
import * as openrouter from "@earendil-works/pi-ai/providers/openrouter.models";
import * as together from "@earendil-works/pi-ai/providers/together.models";
import * as vercelAiGateway from "@earendil-works/pi-ai/providers/vercel-ai-gateway.models";
import * as xai from "@earendil-works/pi-ai/providers/xai.models";
import * as zai from "@earendil-works/pi-ai/providers/zai.models";

export interface BuiltinCatalogModel {
  /** `provider/modelId`: what the agent resolves and the app stores. */
  id: string;
  /** The vendor's own name for it, for the picker. */
  label: string;
  provider: string;
  contextWindow?: number;
  /** No published price. The picker puts these first. */
  free: boolean;
}

/** One model as pi's generated data carries it. */
interface CatalogEntry {
  id?: string;
  name?: string;
  contextWindow?: number;
  cost?: { input?: number; output?: number };
}

/**
 * Each generated module has one export, the catalog keyed by model id. Read
 * positionally: a rename in pi's generator is a missing provider, not a break.
 */
const entriesOf = (namespace: object): CatalogEntry[] => {
  const catalog = Object.values(namespace)[0] as
    | Record<string, CatalogEntry>
    | undefined;
  return catalog == null ? [] : Object.values(catalog);
};

/** Provider id (as the app and the agent name it) → pi's data module. */
const CATALOGS: Record<string, object> = {
  anthropic,
  baseten,
  cerebras,
  deepseek,
  fireworks,
  groq,
  huggingface,
  minimax,
  mistral,
  moonshotai,
  nvidia,
  openai,
  "openai-codex": openaiCodex,
  opencode,
  openrouter,
  together,
  "vercel-ai-gateway": vercelAiGateway,
  xai,
  zai,
};

/** A model pi's catalog lacks, in models.json shape so pi takes it as-is. */
export interface CatalogSupplement {
  id: string;
  name: string;
  api: string;
  baseUrl: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  contextWindow: number;
  maxTokens: number;
  thinkingLevelMap?: Record<string, string | null>;
  compat?: Record<string, boolean>;
}

/**
 * Models newer than the bundled pi release, per provider; pi's remote overlay
 * fills the gap only when its refresh lands. Each entry is the vendor's row
 * from the pi release that added it, and drops out once a bump carries it.
 */
export const CATALOG_SUPPLEMENTS: Record<string, CatalogSupplement[]> = {
  anthropic: [
    {
      id: "claude-fable-5-1",
      name: "Claude Fable 5.1",
      api: "anthropic-messages",
      baseUrl: "https://api.anthropic.com",
      reasoning: true,
      input: ["text", "image"],
      cost: { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
      contextWindow: 1_000_000,
      maxTokens: 128_000,
      thinkingLevelMap: { off: null, xhigh: "xhigh", max: "max" },
      compat: { forceAdaptiveThinking: true, supportsStrictTools: true },
    },
  ],
};

/** The supplements the bundled data still lacks, keyed by provider. */
export const missingCatalogSupplements = (): Record<
  string,
  CatalogSupplement[]
> => {
  const missing: Record<string, CatalogSupplement[]> = {};
  for (const [provider, supplements] of Object.entries(CATALOG_SUPPLEMENTS)) {
    const namespace = CATALOGS[provider];
    const known = new Set(
      namespace == null ? [] : entriesOf(namespace).map((model) => model.id)
    );
    const absent = supplements.filter((model) => !known.has(model.id));
    if (absent.length > 0) missing[provider] = absent;
  }
  return missing;
};

/** Every provider this module can expand. */
export const builtinCatalogProviders = (): string[] => Object.keys(CATALOGS);

/** The catalog entries for `providers`, in order; unknown ones add nothing. */
export const listBuiltinModels = (
  providers: readonly string[]
): BuiltinCatalogModel[] =>
  providers.flatMap((provider) => {
    const namespace = CATALOGS[provider];
    if (namespace == null) return [];

    const entries: CatalogEntry[] = entriesOf(namespace);
    const known = new Set(entries.map((model) => model.id));
    for (const supplement of CATALOG_SUPPLEMENTS[provider] ?? []) {
      if (!known.has(supplement.id)) entries.push(supplement);
    }

    return entries.flatMap((model) => {
      if (model.id == null) return [];

      return [
        {
          id: `${provider}/${model.id}`,
          label: model.name ?? model.id,
          provider,
          ...(typeof model.contextWindow === "number"
            ? { contextWindow: model.contextWindow }
            : {}),
          free:
            (model.cost?.input ?? 0) === 0 && (model.cost?.output ?? 0) === 0,
        },
      ];
    });
  });
