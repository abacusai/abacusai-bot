import fs from "fs";
import path from "path";

import { listBuiltinModels } from "@abacus-ai/agent/model-catalog";

import { MODEL_CATALOG, type ModelAvailability } from "#shared/models";

import { abacusBotHome } from "../../paths";
import { hasCredential, hasOAuthCredential } from "../config/settings";
import {
  cachedAbacusModels,
  clearAbacusCache,
  fetchAbacusAccount,
  fetchAbacusModels,
} from "./abacus";
import {
  cachedFreeOpenRouterModels,
  clearOpenRouterCache,
  fetchFreeOpenRouterModels,
} from "./openrouter";

/**
 * Which models the user can actually run right now: whether each provider's
 * credential exists (env or `~/.abacusai-bot/config.json`, environment
 * winning as in the agent) and which custom endpoints are declared.
 */

interface AbacusBotConfigShape {
  defaultModel?: string;
  customProviders?: Array<{
    id: string;
    name?: string;
    baseUrl?: string;
    apiKey?: string;
    models?: Array<{ id: string; name?: string }>;
  }>;
}

const configPath = (): string => path.join(abacusBotHome(), "config.json");

const readConfig = (): AbacusBotConfigShape => {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(configPath(), "utf8"));
    return parsed && typeof parsed === "object"
      ? (parsed as AbacusBotConfigShape)
      : {};
  } catch {
    return {};
  }
};

export const listAvailableModels = async (
  refresh = false
): Promise<ModelAvailability[]> => {
  if (refresh) {
    clearOpenRouterCache();
    clearAbacusCache();
  }

  // Live catalogs, each gated on its own key, fetched in parallel so the
  // picker does not wait for them in series.
  const [openRouterFree, abacusModels, abacusAccount] = await Promise.all([
    refresh || cachedFreeOpenRouterModels().length === 0
      ? fetchFreeOpenRouterModels()
      : cachedFreeOpenRouterModels(),
    // Abacus's catalog is per-account (org policy gates models).
    refresh || cachedAbacusModels().length === 0
      ? fetchAbacusModels()
      : cachedAbacusModels(),
    // The plan tier picks the recommended default; null (signed out, or the
    // host unreachable) simply leaves no recommendation.
    fetchAbacusAccount(),
  ]);

  const config = readConfig();

  // OpenLLM pools every free-or-nearly-free source, so "configured" means any
  // of their keys exists; a single `requiresEnv` cannot say that.
  const openLlmConfigured =
    hasCredential("OPENROUTER_API_KEY") ||
    hasCredential("GEMINI_API_KEY") ||
    hasCredential("ABACUS_API_KEY");

  const builtins: ModelAvailability[] = MODEL_CATALOG.map((model) => ({
    ...model,
    // A key from the environment or the settings file makes the model
    // runnable; providers with no key at all (a ChatGPT/Codex subscription)
    // are judged by whether pi holds a credential.
    configured:
      model.provider === "openllm"
        ? openLlmConfigured
        : model.requiresEnv != null
          ? hasCredential(model.requiresEnv)
          : hasOAuthCredential(model.provider),
  }));

  // A self-hosted endpoint the user declared is, by definition, configured:
  // they wrote down its URL and (optionally) its key.
  const custom: ModelAvailability[] = (config.customProviders ?? []).flatMap(
    (provider) =>
      (provider.models ?? []).map((model) => ({
        id: `${provider.id}/${model.id}`,
        label: model.name ?? model.id,
        provider: provider.id,
        tier: "local" as const,
        note: provider.name
          ? `${provider.name} · ${provider.baseUrl ?? "local"}`
          : provider.baseUrl,
        configured: true,
      }))
  );

  // Every model the provider's key can run, from pi's catalog, but only once
  // the key exists: without one the curated rows still advertise the provider,
  // and 38 unrunnable rows would be worse than 2. Providers the agent
  // registers itself (gemini, abacus) and the virtual openllm router are not
  // in pi's catalog, so they keep their authored lists.
  const expandable = [
    ...new Set(
      builtins
        .filter((model) => model.configured)
        .map((model) => model.provider)
    ),
  ];
  const curatedById = new Map(builtins.map((model) => [model.id, model]));
  const expanded: ModelAvailability[] = listBuiltinModels(expandable).map(
    (model) => {
      // A curated row for the same model keeps its label, tier and note.
      const curated = curatedById.get(model.id);
      if (curated != null) return { ...curated, configured: true };

      return {
        id: model.id,
        label: model.label,
        provider: model.provider,
        tier: model.free ? ("free" as const) : ("strong" as const),
        configured: true,
      };
    }
  );
  const expandedProviders = new Set(expanded.map((model) => model.provider));

  // The live list and an expanded catalog supersede the curated rows they
  // cover, or the same model would show twice under two labels.
  const withoutSupersededCurated = builtins.filter(
    (model) => !expandedProviders.has(model.provider)
  );

  const withoutStaleFree =
    openRouterFree.length > 0
      ? withoutSupersededCurated.filter(
          (model) => !(model.provider === "openrouter" && model.tier === "free")
        )
      : withoutSupersededCurated;

  // Same rule for Abacus: the live catalog replaces every static row under
  // the catalog's own names. A known free-tier account drops them even before
  // the live list answers: the static rows describe a paid catalog and read as
  // configured to anyone holding an Abacus key, so one slow or failed
  // /v1/models fetch would offer a free user a lineup none of which is servable.
  const freeTier = abacusAccount?.subscription_tier === "free";
  const withoutStaticAbacus =
    abacusModels.length > 0 || freeTier
      ? withoutStaleFree.filter((model) => model.provider !== "abacus")
      : withoutStaleFree;

  // A paying tier lives on its RouteLLM router and has no OpenLLM at all,
  // whatever other keys are configured.
  const payingTier =
    abacusAccount?.subscription_tier != null &&
    ["basic", "go", "pro", "max"].includes(abacusAccount.subscription_tier);
  const presented = payingTier
    ? withoutStaticAbacus.filter((model) => model.provider !== "openllm")
    : withoutStaticAbacus;

  // The free tier's dropdown is OpenLLM plus its plan models; the low code
  // router stays off the list (still OpenLLM's routing lane underneath). The
  // live OpenRouter list wins over a catalog row for the same id.
  const liveIds = new Set(openRouterFree.map((model) => model.id));
  const composed = [
    ...presented,
    ...expanded.filter((model) => !liveIds.has(model.id)),
    ...openRouterFree,
    ...abacusModels,
    ...custom,
  ];
  const all = freeTier
    ? composed.filter((model) => model.id !== "abacus/route-llm-code-low")
    : composed;

  // Auto-select by plan when nothing valid is chosen. At most one entry is
  // marked, and only a runnable one: a tier whose router is missing from this
  // account's catalog recommends nothing.
  const RECOMMENDED_BY_TIER: Record<string, string> = {
    free: "openllm/auto",
    go: "abacus/route-llm-code-low",
    basic: "abacus/route-llm-code-low",
    pro: "abacus/route-llm-code",
    max: "abacus/route-llm-code",
  };
  const recommendedId =
    abacusAccount?.subscription_tier != null
      ? RECOMMENDED_BY_TIER[abacusAccount.subscription_tier]
      : undefined;
  const withRecommendation = all.map((model) =>
    model.id === recommendedId && model.configured
      ? { ...model, recommended: true }
      : model
  );

  // Free models first; order within a tier is preserved.
  const tierRank = (model: ModelAvailability): number =>
    model.tier === "free" ? 0 : 1;

  return withRecommendation.sort((a, b) => tierRank(a) - tierRank(b));
};
