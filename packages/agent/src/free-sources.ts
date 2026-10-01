/**
 * The providers RouteLLM - Open pools, in the order it tries them, and what
 * each one's free tier allows. One table, so adding a source is a row here
 * plus a key field in the app, not a change to the router.
 *
 * Limits are the published free-tier numbers (checked 2026-10-01). They are
 * advisory: a key that keeps answering past them is on a paid tier, and the
 * quota ledger stops holding it back (see openllm-quota.ts).
 */

/** Calls and tokens one window allows; an absent field is no limit. */
export interface WindowLimits {
  rpm?: number;
  rpd?: number;
  tpm?: number;
  tpd?: number;
}

export interface FreeSource {
  /** pi's provider id. */
  provider: string;
  /**
   * The models pooled, best first. Absent: membership is decided by a rule
   * in openllm.ts (Abacus's catalog flag, OpenRouter's `:free` suffix, every
   * Gemini or local model).
   */
  models?: readonly string[];
  limits?: WindowLimits;
  /** The limits count every model on the key together, not each one. */
  accountWide?: boolean;
}

/**
 * The order the pool spends them: the account's own Abacus credits, then
 * the two sources the app offers first (a Studio key's Gemini quota,
 * OpenRouter's free models), then the rest. Mistral and NVIDIA carry strong
 * models with room for a whole agent turn; Cerebras is a short trial; Groq's
 * free tier allows 8K tokens a minute, under one agent request, so it only
 * helps a paid key. Local is the floor.
 */
export const FREE_SOURCES: readonly FreeSource[] = [
  { provider: "abacus" },
  { provider: "gemini" },
  {
    provider: "openrouter",
    // Shared by every `:free` model on the key.
    limits: { rpm: 20 },
    accountWide: true,
  },
  {
    provider: "mistral",
    models: [
      "devstral-latest",
      "mistral-medium-latest",
      "codestral-latest",
      "mistral-small-latest",
    ],
    // One request a second across the account.
    limits: { rpm: 60, tpm: 500_000 },
    accountWide: true,
  },
  {
    provider: "nvidia",
    models: [
      "moonshotai/kimi-k3",
      "z-ai/glm-5.3",
      "moonshotai/kimi-k2.6",
      "deepseek-ai/deepseek-v4.1-flash",
      "nvidia/nemotron-3-super-120b-a12b",
    ],
    limits: { rpm: 40 },
    accountWide: true,
  },
  {
    provider: "cerebras",
    models: ["gpt-oss-120b", "qwen-3.8-27b"],
    limits: { rpm: 5, tpm: 90_000, tpd: 1_000_000 },
  },
  {
    provider: "groq",
    models: ["openai/gpt-oss-120b", "qwen/qwen3.8-27b", "openai/gpt-oss-20b"],
    limits: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000 },
  },
  { provider: "local" },
];

const BY_PROVIDER = new Map(
  FREE_SOURCES.map((source, rank) => [source.provider, { source, rank }])
);

export const freeSource = (provider: string): FreeSource | undefined =>
  BY_PROVIDER.get(provider)?.source;

/** Where a provider sits in the pool's order; unknown providers trail. */
export const sourceRank = (provider: string): number =>
  BY_PROVIDER.get(provider)?.rank ?? FREE_SOURCES.length;

/** A listed model's place within its source, or -1 when not listed. */
export const listedModelRank = (provider: string, modelId: string): number =>
  freeSource(provider)?.models?.indexOf(modelId) ?? -1;
