import fs from "fs";
import path from "path";

import {
  clearLiveModelIds,
  listBuiltinModels,
  refreshLiveModelIds,
} from "@abacus-ai/agent/model-catalog";
import type { PlanTopModel } from "@abacus-ai/contract/billing-plan";
import { FREE_POOL_PROVIDERS } from "@abacus-ai/contract/free-pool";
import {
  isPayingAbacusTier,
  OPENLLM_ID,
  MODEL_CATALOG,
  type ModelAvailability,
} from "@abacus-ai/contract/models";
import { PROVIDER_KEY_FIELDS } from "@abacus-ai/contract/settings";

import { abacusBotHome } from "../../paths";
import {
  credentialFor,
  hasCredential,
  hasOAuthCredential,
} from "../config/settings";
import {
  abacusPaymentRequired,
  cachedAbacusModels,
  clearAbacusCache,
  fetchAbacusAccount,
  fetchAbacusModels,
  planLockedAbacusIds,
} from "./abacus";
import { fetchBillingPlan } from "./abacus-upgrade";
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

/**
 * The plan tier's default, as of the last catalog read: the last step of
 * `resolveSessionModel`, after the session's own ask and the stored default.
 */
let lastRecommendedId: string | null = null;

export const cachedRecommendedModelId = (): string | null => lastRecommendedId;

/**
 * What the account's billing plan says about models: the plan the platform
 * offers it first (its first upgrade), which a locked model is "included in",
 * and the paid plans' leading models by catalog id. Cached, since the picker
 * reads the catalog often.
 */
const UNLOCK_PLAN_TTL_MS = 10 * 60_000;
interface UnlockPlan {
  name: string | null;
  topModels: PlanTopModel[];
}
let unlockPlanCache: { plan: UnlockPlan; at: number } | null = null;

const unlockPlan = async (): Promise<UnlockPlan> => {
  if (
    unlockPlanCache != null &&
    Date.now() - unlockPlanCache.at < UNLOCK_PLAN_TTL_MS
  )
    return unlockPlanCache.plan;
  const billing = await fetchBillingPlan(false).catch(() => null);
  const plan = {
    name: billing?.upgrades[0]?.planName ?? null,
    topModels: billing?.topModels ?? [],
  };
  unlockPlanCache = { plan, at: Date.now() };
  return plan;
};

/**
 * Each plan's own model: what is auto-selected when nothing valid is chosen,
 * and where a pin the plan does not serve moves (`modelForTier`). Free, Go
 * and Basic run on RouteLLM - Open; Pro and Max on the code router.
 */
const RECOMMENDED_BY_TIER: Record<string, string> = {
  free: OPENLLM_ID,
  go: OPENLLM_ID,
  basic: OPENLLM_ID,
  pro: "abacus/route-llm-code",
  max: "abacus/route-llm-code",
};

/** The code routers: a plan on RouteLLM - Open neither lists nor runs them. */
const CODE_ROUTER_IDS = new Set([
  "abacus/route-llm-code-low",
  "abacus/route-llm-code",
]);

/** Whether `tier` runs on RouteLLM - Open (else on its code router). */
const runsOnOpenLlm = (tier: string | null | undefined): boolean =>
  RECOMMENDED_BY_TIER[tier ?? ""] === OPENLLM_ID;

/**
 * The model a pin to `id` runs on under `tier`: a plan on RouteLLM - Open
 * moves a code-router pin to it, a plan on the code router moves an OpenLLM
 * pin to its router (its catalog has no OpenLLM). Every other pin, and every
 * pin on an unknown tier, is kept as it is.
 */
export const modelForTier = (
  tier: string | null | undefined,
  id: string
): string => {
  const own = RECOMMENDED_BY_TIER[tier ?? ""];
  if (own == null) return id;
  if (own === OPENLLM_ID) return CODE_ROUTER_IDS.has(id) ? own : id;
  return id.startsWith("openllm/") ? own : id;
};

/** What a refused id is called when no catalog row names it. */
const lockedLabel = (id: string): string => id.split("/").at(-1) ?? id;

export const listAvailableModels = async (
  refresh = false
): Promise<ModelAvailability[]> => {
  if (refresh) {
    clearOpenRouterCache();
    clearAbacusCache();
    clearLiveModelIds();
    unlockPlanCache = null;
  }

  // Live catalogs, each gated on its own key, fetched in parallel so the
  // picker does not wait for them in series.
  const [openRouterFree, liveAbacusModels, abacusAccount] = await Promise.all([
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
    // Groq and NVIDIA retire models faster than pi's catalog is
    // regenerated; their live lists drop the dead rows from the catalog.
    refreshLiveModelIds(credentialFor),
  ]);

  const config = readConfig();
  // An account the payment gate refuses runs nothing on Abacus: no row may
  // read as configured, or every turn on it would answer 402.
  const abacusBlocked = abacusPaymentRequired() != null;
  const abacusModels = abacusBlocked ? [] : liveAbacusModels;

  // OpenLLM pools every free-or-nearly-free source, so "configured" means any
  // of their keys exists; a single `requiresEnv` cannot say that.
  const openLlmConfigured =
    (hasCredential("ABACUS_API_KEY") && !abacusBlocked) ||
    FREE_POOL_PROVIDERS.some((provider) => {
      const envVar = PROVIDER_KEY_FIELDS.find(
        (field) => field.provider === provider
      )?.envVar;
      return envVar != null && hasCredential(envVar);
    });

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
  // OpenRouter is connected for its free models, and a new OpenRouter account
  // has no balance: every paid row from pi's catalog answered 402, `:batch`
  // rows cannot chat, and `:free` rows the live list no longer carries answer
  // 404. Off a paying tier only the live free list is offered; a paying tier
  // keeps the paid rows, marked, for users with credits on OpenRouter.
  const payingTier = isPayingAbacusTier(abacusAccount?.subscription_tier);
  const liveOpenRouterIds = new Set(openRouterFree.map((model) => model.id));
  const servableExpanded = expanded.flatMap((model) => {
    if (model.provider !== "openrouter") return [model];
    if (!payingTier || model.id.endsWith(":batch")) return [];
    if (model.tier !== "free")
      return [{ ...model, note: "Needs OpenRouter credits" }];
    return openRouterFree.length === 0 || liveOpenRouterIds.has(model.id)
      ? [model]
      : [];
  });
  const expandedProviders = new Set(
    servableExpanded.map((model) => model.provider)
  );

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
  //
  // Locked, not dropped, on the free plan: the static rows are the paid
  // catalog, and a model the platform refused for this plan at run time
  // stays refused while the plan is the same, even if a list still names it.
  // Neither is selectable; the picker sells the plan that includes them.
  const freeTier = abacusAccount?.subscription_tier === "free";
  const refused = planLockedAbacusIds();
  const liveAbacusIds = new Set(abacusModels.map((model) => model.id));
  const lock = (model: ModelAvailability): ModelAvailability => {
    const { recommended: _recommended, ...rest } = model;
    return { ...rest, configured: false, access: "locked" };
  };
  const staticAbacus = withoutStaleFree.filter(
    (model) => model.provider === "abacus"
  );
  // The paid plans' leading models, by the ids the billing plan names, are
  // the free plan's locked rows; the static rows only stand in for a server
  // that names none (an older one, or the call failed).
  const freePlan = freeTier ? await unlockPlan() : null;
  const planLocked: ModelAvailability[] = (freePlan?.topModels ?? [])
    .filter((model) => model.agentic !== false)
    .map((model) => ({
      id: `abacus/${model.id}`,
      label: model.name,
      provider: "abacus",
      tier: "strong" as const,
      requiresEnv: "ABACUS_API_KEY",
      configured: false,
      access: "locked" as const,
    }));
  const lockedStatic = (
    planLocked.length > 0 ? planLocked : staticAbacus.map(lock)
  ).filter((model) => freeTier && !liveAbacusIds.has(model.id));
  const withoutStaticAbacus =
    abacusModels.length > 0 || freeTier || abacusBlocked
      ? withoutStaleFree.filter((model) => model.provider !== "abacus")
      : withoutStaleFree;
  const listedIds = new Set([
    ...withoutStaticAbacus.map((model) => model.id),
    ...abacusModels.map((model) => model.id),
    ...lockedStatic.map((model) => model.id),
  ]);
  const lockedRefused: ModelAvailability[] = [...refused]
    .filter((id) => !listedIds.has(id))
    .map((id) => ({
      id,
      label: lockedLabel(id),
      provider: "abacus",
      tier: "strong" as const,
      requiresEnv: "ABACUS_API_KEY",
      configured: false,
      access: "locked" as const,
    }));
  const abacusRows = [
    ...abacusModels.map((model) =>
      refused.has(model.id) ? lock(model) : model
    ),
    ...lockedStatic,
    ...lockedRefused,
  ];

  // A tier on the code router (Pro, Max) has no OpenLLM at all, whatever
  // other keys are configured.
  const tier = abacusAccount?.subscription_tier;
  const presented = (
    payingTier && !runsOnOpenLlm(tier)
      ? withoutStaticAbacus.filter((model) => model.provider !== "openllm")
      : withoutStaticAbacus
  ).map((model) => (refused.has(model.id) ? lock(model) : model));

  // A tier on RouteLLM - Open (Free, Go, Basic) lists OpenLLM plus its plan
  // models; the code routers stay off the list. The live OpenRouter list wins
  // over a catalog row for the same id.
  const composed = [
    ...presented,
    ...servableExpanded.filter((model) => !liveOpenRouterIds.has(model.id)),
    ...openRouterFree,
    ...abacusRows,
    ...custom,
  ];
  const all = runsOnOpenLlm(tier)
    ? composed.filter((model) => !CODE_ROUTER_IDS.has(model.id))
    : composed;

  // Auto-select by plan when nothing valid is chosen. At most one entry is
  // marked, and only a runnable one: a tier whose router is missing from this
  // account's catalog recommends nothing.
  const recommendedId = tier != null ? RECOMMENDED_BY_TIER[tier] : undefined;
  const withRecommendation = all.map((model) =>
    model.id === recommendedId && model.configured
      ? { ...model, recommended: true }
      : model
  );
  lastRecommendedId =
    withRecommendation.find((model) => model.recommended === true)?.id ?? null;

  // Every row says which of the three it is; a locked one, which plan
  // includes it.
  const unlockPlanName = withRecommendation.some(
    (model) => model.access === "locked"
  )
    ? (await unlockPlan()).name
    : null;
  const withAccess = withRecommendation.map((model): ModelAvailability =>
    model.access === "locked"
      ? unlockPlanName == null
        ? model
        : { ...model, unlockPlan: unlockPlanName }
      : { ...model, access: model.configured ? "runnable" : "needs-key" }
  );

  // Free models first; order within a tier is preserved.
  const tierRank = (model: ModelAvailability): number =>
    model.tier === "free" ? 0 : 1;

  return withAccess.sort((a, b) => tierRank(a) - tierRank(b));
};
