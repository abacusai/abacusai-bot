/**
 * AbacusAIBot's static model catalog, shown by the composer's model picker.
 * Every id is a real pi model reference (`provider/model-id`), so selecting one
 * resolves and runs. Order is display order. `requiresEnv` lets the picker tell
 * "runs now" from "needs a key first".
 */

export type ModelTier = "default" | "strong" | "fast" | "free" | "local";

export interface AbacusBotModel {
  /** Canonical `provider/model-id` — exactly what `set_model` sends. */
  id: string;
  label: string;
  provider: string;
  tier: ModelTier;
  /** One-line note shown under the label in the picker. */
  note?: string;
  /** Env var (or config key) that must be present for this model to run. */
  requiresEnv?: string;
}

export const MODEL_CATALOG: AbacusBotModel[] = [
  // ── The defaults ──────────────────────────────────────────────────────────
  // OpenLLM's virtual id resolves to the best model in the free pool, with
  // fallback when a model fails. It must match OPENLLM_ID in
  // packages/agent/src/openllm.ts. Keep its tier distinct from "free" so live
  // catalog supersession preserves it. `requiresEnv` names the primary source;
  // openLlmConfigured also accepts other configured pool sources.
  {
    id: "openllm/auto",
    // The id stays `openllm/auto` (stored in sessions, matched by OPENLLM_ID);
    // only the on-screen name says it is the same routing idea as RouteLLM.
    label: "RouteLLM - Open",
    provider: "openllm",
    tier: "default",
    note: "Every free model you can run — OpenRouter free tier, Gemini's free quota, cheap Abacus routes, local Ollama — with automatic fallback when one fails or rate-limits",
    requiresEnv: "OPENROUTER_API_KEY",
  },
  // Fetch-failure fallback only: the live per-account catalog supersedes every
  // static Abacus entry. The CHAT router (route-llm) stays out: above 5000
  // tokens of context it short-circuits to a Flash model, which a coding agent
  // passes on its system prompt alone.
  {
    id: "abacus/route-llm-code-low",
    label: "RouteLLM",
    provider: "abacus",
    tier: "default",
    note: "Abacus.AI's cost-optimising code router · routes each turn to a cheap model that fits",
    requiresEnv: "ABACUS_API_KEY",
  },
  {
    id: "deepseek/deepseek-v4-flash",
    label: "DeepSeek V4 Flash",
    provider: "deepseek",
    tier: "default",
    note: "Default · $0.14/M in · what the harness is tuned for",
    requiresEnv: "DEEPSEEK_API_KEY",
  },
  {
    id: "deepseek/deepseek-v4-pro",
    label: "DeepSeek V4 Pro",
    provider: "deepseek",
    tier: "strong",
    note: "Stronger DeepSeek · ~3x the cost of Flash",
    requiresEnv: "DEEPSEEK_API_KEY",
  },

  // ── One Abacus.AI subscription, every model ───────────────────────────────
  // Agentic-capable models only, matching the live catalog's filter. This is
  // the offline fallback; /v1/models is the source when available.
  {
    id: "abacus/claude-sonnet-5",
    label: "Claude Sonnet 5 (Abacus)",
    provider: "abacus",
    tier: "strong",
    note: "Via your Abacus.AI subscription",
    requiresEnv: "ABACUS_API_KEY",
  },
  {
    id: "abacus/claude-opus-5",
    label: "Claude Opus 5 (Abacus)",
    provider: "abacus",
    tier: "strong",
    note: "Via your Abacus.AI subscription",
    requiresEnv: "ABACUS_API_KEY",
  },
  {
    id: "abacus/gpt-5.6-terra",
    label: "GPT-5.6 Terra (Abacus)",
    provider: "abacus",
    tier: "strong",
    note: "Via your Abacus.AI subscription",
    requiresEnv: "ABACUS_API_KEY",
  },
  {
    id: "abacus/moonshotai/Kimi-K2.7-Code",
    label: "Kimi K2.7 Code (Abacus)",
    provider: "abacus",
    tier: "fast",
    note: "Agentic coding model · via Abacus.AI",
    requiresEnv: "ABACUS_API_KEY",
  },

  // ── Bring the big models out for hard work ────────────────────────────────
  {
    id: "anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5",
    provider: "anthropic",
    tier: "strong",
    note: "Strong all-rounder for tough tasks",
    requiresEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "anthropic/claude-opus-5",
    label: "Claude Opus 5",
    provider: "anthropic",
    tier: "strong",
    note: "Most capable · use when the task is genuinely hard",
    requiresEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "anthropic/claude-haiku-4-5",
    label: "Claude Haiku 4.5",
    provider: "anthropic",
    tier: "fast",
    note: "Fast and cheap for routine edits",
    requiresEnv: "ANTHROPIC_API_KEY",
  },
  {
    id: "openai/gpt-5.6-sol",
    label: "GPT-5.6 Sol",
    provider: "openai",
    tier: "strong",
    note: "OpenAI flagship",
    requiresEnv: "OPENAI_API_KEY",
  },
  {
    id: "openai-codex/gpt-5.6-sol",
    label: "GPT-5.6 Sol (Codex)",
    provider: "openai-codex",
    tier: "strong",
    note: "Via a ChatGPT/Codex subscription instead of an API key",
  },
  {
    id: "gemini/gemini-3.6-flash",
    label: "Gemini 3.6 Flash",
    provider: "gemini",
    tier: "strong",
    note: "Google flagship · 1M context",
    requiresEnv: "GEMINI_API_KEY",
  },
  {
    id: "gemini/gemini-3.5-flash-lite",
    label: "Gemini 3.5 Flash-Lite",
    provider: "gemini",
    tier: "fast",
    note: "Cheap Google option · 1M context",
    requiresEnv: "GEMINI_API_KEY",
  },
  {
    id: "openai/gpt-5.6-luna",
    label: "GPT-5.6 Luna",
    provider: "openai",
    tier: "fast",
    note: "Cheap OpenAI option",
    requiresEnv: "OPENAI_API_KEY",
  },

  // ── The long tail, one flagship each ──────────────────────────────────────
  // One or two entries per key-paste provider from PROVIDER_KEY_FIELDS; the
  // rest of each provider's catalog stays reachable by id from the CLI.
  {
    id: "groq/openai/gpt-oss-120b",
    label: "GPT-OSS 120B (Groq)",
    provider: "groq",
    tier: "fast",
    note: "Open-weights flagship at LPU speed · $0.15/M in",
    requiresEnv: "GROQ_API_KEY",
  },
  {
    id: "cerebras/gpt-oss-120b",
    label: "GPT-OSS 120B (Cerebras)",
    provider: "cerebras",
    tier: "fast",
    note: "Wafer-scale inference · the fastest tokens anywhere",
    requiresEnv: "CEREBRAS_API_KEY",
  },
  {
    id: "xai/grok-build-0.1",
    label: "Grok Build 0.1",
    provider: "xai",
    tier: "fast",
    note: "xAI's coding model · $1/M in",
    requiresEnv: "XAI_API_KEY",
  },
  {
    id: "xai/grok-4.6",
    label: "Grok 4.6",
    provider: "xai",
    tier: "strong",
    note: "xAI flagship",
    requiresEnv: "XAI_API_KEY",
  },
  {
    id: "mistral/devstral-medium-latest",
    label: "Devstral 2",
    provider: "mistral",
    tier: "fast",
    note: "Mistral's agentic coding model · EU hosting",
    requiresEnv: "MISTRAL_API_KEY",
  },
  {
    id: "mistral/mistral-large-latest",
    label: "Mistral Large",
    provider: "mistral",
    tier: "strong",
    note: "Mistral flagship · EU hosting",
    requiresEnv: "MISTRAL_API_KEY",
  },
  {
    id: "minimax/MiniMax-M3",
    label: "MiniMax M3",
    provider: "minimax",
    tier: "fast",
    note: "Agentic flagship · 1M context · $0.3/M in",
    requiresEnv: "MINIMAX_API_KEY",
  },
  {
    id: "moonshotai/kimi-k2.7-code",
    label: "Kimi K2.7 Code",
    provider: "moonshotai",
    tier: "strong",
    note: "Moonshot's agentic coding flagship",
    requiresEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "moonshotai/kimi-k3",
    label: "Kimi K3",
    provider: "moonshotai",
    tier: "strong",
    note: "Moonshot's largest · 1M context",
    requiresEnv: "MOONSHOT_API_KEY",
  },
  {
    id: "zai/glm-5.2",
    label: "GLM-5.2",
    provider: "zai",
    tier: "strong",
    note: "Via a Z.ai GLM Coding Plan subscription",
    requiresEnv: "ZAI_API_KEY",
  },
  {
    id: "together/deepseek-ai/DeepSeek-V4-Flash-0731",
    label: "DeepSeek V4 Flash (Together)",
    provider: "together",
    tier: "fast",
    note: "Open-model host · $0.14/M in",
    requiresEnv: "TOGETHER_API_KEY",
  },
  {
    id: "fireworks/accounts/fireworks/models/deepseek-v4-flash",
    label: "DeepSeek V4 Flash (Fireworks)",
    provider: "fireworks",
    tier: "fast",
    note: "Fast open-model serving · $0.14/M in",
    requiresEnv: "FIREWORKS_API_KEY",
  },
  {
    id: "baseten/deepseek-ai/DeepSeek-V4-Flash-0731",
    label: "DeepSeek V4 Flash (Baseten)",
    provider: "baseten",
    tier: "fast",
    note: "Dedicated open-model infra · $0.13/M in",
    requiresEnv: "BASETEN_API_KEY",
  },
  {
    id: "huggingface/deepseek-ai/DeepSeek-V4-Flash",
    label: "DeepSeek V4 Flash (Hugging Face)",
    provider: "huggingface",
    tier: "fast",
    note: "Via HF Inference Providers · one token, many hosts",
    requiresEnv: "HF_TOKEN",
  },
  {
    id: "nvidia/nvidia/nemotron-3-super-120b-a12b",
    label: "Nemotron 3 Super",
    provider: "nvidia",
    tier: "fast",
    note: "NVIDIA NIM · free credits to start",
    requiresEnv: "NVIDIA_API_KEY",
  },
  {
    id: "vercel-ai-gateway/anthropic/claude-sonnet-5",
    label: "Claude Sonnet 5 (Vercel)",
    provider: "vercel-ai-gateway",
    tier: "strong",
    note: "Via Vercel AI Gateway · one key, every major model",
    requiresEnv: "AI_GATEWAY_API_KEY",
  },
  {
    id: "opencode/deepseek-v4-flash",
    label: "DeepSeek V4 Flash (OpenCode)",
    provider: "opencode",
    tier: "fast",
    note: "OpenCode Zen · curated coding models",
    requiresEnv: "OPENCODE_API_KEY",
  },

  // ── Free tier ─────────────────────────────────────────────────────────────
  // OpenLLM itself sits at the top of the catalog; these are the offline
  // fallback entries the live free list supersedes.
  {
    id: "openrouter/openai/gpt-oss-20b:free",
    label: "GPT-OSS 20B (free)",
    provider: "openrouter",
    tier: "free",
    note: "Free on OpenRouter · key needed, no charge",
    requiresEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "openrouter/nvidia/nemotron-3-super-120b-a12b:free",
    label: "Nemotron 3 Super 120B (free)",
    provider: "openrouter",
    tier: "free",
    note: "Free on OpenRouter · larger, slower",
    requiresEnv: "OPENROUTER_API_KEY",
  },
  {
    id: "openrouter/google/gemma-4-31b-it:free",
    label: "Gemma 4 31B (free)",
    provider: "openrouter",
    tier: "free",
    note: "Free on OpenRouter",
    requiresEnv: "OPENROUTER_API_KEY",
  },
];

/** Shown when a model's provider has no credential yet. */
export const TIER_LABELS: Record<ModelTier, string> = {
  default: "Recommended",
  strong: "For harder tasks",
  fast: "Fast & cheap",
  free: "Free",
  local: "Local / custom",
};

/** Display order of the groups in the picker: free and cheap before strong. */
export const TIER_ORDER: ModelTier[] = [
  "default",
  "free",
  "fast",
  "strong",
  "local",
];

/** A catalog entry plus whether it can actually run right now. */
export interface ModelAvailability extends AbacusBotModel {
  configured: boolean;
  /**
   * Auto-selected when no valid pick exists. Set on at most one entry, from
   * the Abacus.AI plan tier; absent when no Abacus account is signed in.
   */
  recommended?: boolean;
}

export const DEFAULT_MODEL_ID = "deepseek/deepseek-v4-flash";

/**
 * True once any catalog entry has a credential. The composer blocks typing
 * while this is false, so it must agree with the model picker exactly: both
 * read the same catalog, and neither singles out a provider.
 */
export const hasUsableModel = (
  models: ModelAvailability[] | undefined | null
): boolean => models?.some((model) => model.configured) === true;

/**
 * The paid-plan signal, read off the catalog rather than a plan label: the
 * free tier's list never carries `route-llm-code`, and that absence survives a
 * plan being renamed, which comparing against "Free" does not.
 */
export const ABACUS_CODE_ROUTER_ID = "abacus/route-llm-code";

/**
 * The paying self-serve tiers. Their onboarding skips the models step (the
 * plan already covers the catalog, and RouteLLM is preselected), and their
 * dropdown carries no free-pool connect rows.
 */
export const PAYING_ABACUS_TIERS = ["basic", "go", "pro", "max"] as const;

export const isPayingAbacusTier = (tier: string | null | undefined): boolean =>
  tier != null && (PAYING_ABACUS_TIERS as readonly string[]).includes(tier);

export const isAbacusSubscriber = (
  models: ModelAvailability[] | undefined | null
): boolean =>
  models?.some(
    (model) => model.id === ABACUS_CODE_ROUTER_ID && model.configured
  ) === true;
