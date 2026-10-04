/**
 * The providers whose key adds models to RouteLLM - Open, in the order the
 * pool spends them after Abacus and the app offers to connect them. The agent's FREE_SOURCES table
 * (packages/agent/src/free-sources.ts) says which of their models it pools
 * and in what order; keep the two lists in step.
 */
export const FREE_POOL_PROVIDERS = [
  "gemini",
  "openrouter",
  "mistral",
  "nvidia",
  "cerebras",
  "groq",
] as const;

export type FreePoolProvider = (typeof FREE_POOL_PROVIDERS)[number];

export const isFreePoolProvider = (
  provider: string
): provider is FreePoolProvider =>
  (FREE_POOL_PROVIDERS as readonly string[]).includes(provider);
