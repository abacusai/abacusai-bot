import type { AbacusAccountInfo } from "#shared/contracts";
import type { ModelAvailability, ModelTier } from "#shared/models";

import { hasCredential, readSettings } from "../config/settings";
import { abacusRoutellmV1, abacusUserAgent } from "./abacus-host";

/**
 * Abacus.AI's live model catalog. The list is per-account (org policy flags
 * gate models), so `/v1/models` says what this key may call. Same contract as
 * `openrouter.ts`: cached for the process lifetime, dropped when the
 * credential changes, and a failure returns nothing so the picker stays full.
 */

const ENV_VAR = "ABACUS_API_KEY";

/** Media models are reachable through the generation tools, not the chat picker. */
const TEXT_MODEL_TYPE = "text_generation";

interface AbacusModel {
  id: string;
  name?: string;
  display_name?: string;
  model_type?: string;
  output_modalities?: string[];
  context_length?: number;
  max_completion_tokens?: number;
  input_token_rate?: number | string;
  output_token_rate?: number | string;
  featured?: boolean;
  top_model?: boolean;
  agentic?: boolean;
  code_agent?: boolean;
  thinking?: boolean;
  /** Priced $0/$0 by the platform: bills nothing, and keeps serving once the balance is gone. */
  free?: boolean;
}

/** What a $0 model's row says; the platform decides which rows those are. */
const FREE_MODEL_NOTE = "Free — doesn't use credits";

let cache: ModelAvailability[] | null = null;

/**
 * Has the platform refused the key we hold? A timeout or 500 means "ask again
 * later"; a 401/403 means the key is over and retrying cannot help. Kept
 * apart from the caches because it is the one failure the app must act on.
 */
let credentialRejected = false;

/** Whether the stored key has been refused outright. See `credentialRejected`. */
export const abacusCredentialRejected = (): boolean => credentialRejected;

const isTextModel = (model: AbacusModel): boolean => {
  if (model.model_type != null && model.model_type !== TEXT_MODEL_TYPE)
    return false;

  // Some entries omit the field; assume text rather than dropping them.
  return (
    model.output_modalities == null || model.output_modalities.includes("text")
  );
};

/**
 * The routers, which resolve to a different model per turn. `route-llm` is
 * the chat router and short-circuits to a Flash model above 5000 tokens of
 * context, which an agent loop does not survive. `route-llm-code` classifies
 * each turn onto the coding ladder; `-low` does the same on the cheap ladder.
 */
const CHAT_ROUTER_ID = "route-llm";
const CODE_ROUTER_ID = "route-llm-code";
const CODE_ROUTER_LOW_ID = "route-llm-code-low";

/** What both code routers are called in the picker. */
const ROUTER_LABEL = "RouteLLM";
const ROUTER_IDS = new Set([CODE_ROUTER_ID, CODE_ROUTER_LOW_ID]);

/**
 * Models offered as the agent's driver. `code_agent` is the platform's bar for
 * coding-agent drivers; `agentic` is the stricter general bar, kept for a
 * server that predates the newer flag. Offering everything is not acceptable:
 * a chat-only model in an agent loop answers "how can I help?" instead.
 */
const canDriveTheAgent = (model: AbacusModel): boolean => {
  if (!isTextModel(model)) return false;

  // The chat router is never offered, whatever the platform flags say: it
  // short-circuits to a Flash model above 5000 tokens of context.
  if (model.id === CHAT_ROUTER_ID) return false;

  return model.code_agent === true || model.agentic === true;
};

/** Per-million input dollars, or null when the catalog quotes no usable rate. */
const inputPerMillion = (model: AbacusModel): number | null => {
  const value = Number(model.input_token_rate ?? NaN) * 1_000_000;

  return Number.isFinite(value) && value > 0 ? value : null;
};

/** Same for output, which breaks ties between models with equal input rates. */
const outputPerMillion = (model: AbacusModel): number | null => {
  const value = Number(model.output_token_rate ?? NaN) * 1_000_000;

  return Number.isFinite(value) && value > 0 ? value : null;
};

/**
 * What the app selects on its own: the low code router, then the standard
 * one, then named models for a catalog that predates the routers (never
 * `route-llm`, the chat router). Failing all of those, the cheapest driver by
 * input rate, since an agent burns far more input than output.
 */
const PREFERRED_DEFAULTS = [
  CODE_ROUTER_LOW_ID,
  CODE_ROUTER_ID,
  "moonshotai/Kimi-K2.7-Code",
  "claude-sonnet-5",
];

const cheapestId = (models: AbacusModel[]): string | undefined => {
  const priced = models.filter((model) => inputPerMillion(model) != null);

  if (priced.length === 0) return undefined;

  return priced.reduce((cheapest, model) => {
    const byInput =
      (inputPerMillion(model) ?? 0) - (inputPerMillion(cheapest) ?? 0);

    if (byInput !== 0) return byInput < 0 ? model : cheapest;

    return (outputPerMillion(model) ?? 0) < (outputPerMillion(cheapest) ?? 0)
      ? model
      : cheapest;
  }).id;
};

const CHEAP_PER_MILLION = 1.5;

const tierFor = (
  model: AbacusModel,
  isDefault: boolean,
  freeTierAccount: boolean
): ModelTier => {
  if (isDefault) return "default";
  // A free-tier account's whole catalog is included in its signup credits, so
  // it belongs in the picker's Free group, not the paid cost buckets.
  if (freeTierAccount) return "free";
  // All of these can drive the agent, so the useful split is what they cost.
  const perMillion = inputPerMillion(model);

  return perMillion != null && perMillion < CHEAP_PER_MILLION
    ? "fast"
    : "strong";
};

/** Rates arrive as per-token dollars; per-million is what pricing pages quote. */
const noteFor = (model: AbacusModel): string => {
  const perMillion = inputPerMillion(model);

  if (perMillion == null) return "Via your Abacus.AI subscription";

  const rounded =
    perMillion >= 1
      ? perMillion.toFixed(2).replace(/\.00$/, "")
      : perMillion.toFixed(2);

  return `Abacus.AI · $${rounded}/M in`;
};

/** What the platform says when the key itself is the problem. */
const REJECTED_STATUSES = new Set([401, 403]);

const resolveKey = (): string | undefined => {
  const fromEnv = process.env[ENV_VAR];
  if (fromEnv != null && fromEnv.length > 0) return fromEnv;

  return readSettings().apiKeys?.[ENV_VAR];
};

/** The Abacus key, for main-process callers outside the model provider. */
export const resolveAbacusApiKey = (): string | null => resolveKey() ?? null;

export const fetchAbacusModels = async (): Promise<ModelAvailability[]> => {
  const key = resolveKey();

  if (key == null || key.length === 0) return [];

  try {
    const response = await fetch(`${abacusRoutellmV1()}/models`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "user-agent": abacusUserAgent(),
      },
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      if (REJECTED_STATUSES.has(response.status)) credentialRejected = true;

      return withCurrentConfigured(cache);
    }

    const body = (await response.json()) as { data?: AbacusModel[] };

    const usable = (body.data ?? []).filter(canDriveTheAgent);
    // Free-tier catalogs carry the low code router but never route-llm-code;
    // that presence test is the tier signal, with no extra endpoint.
    const freeTierAccount =
      usable.length > 0 &&
      !(body.data ?? []).some((model) => model.id === "route-llm-code");
    // Exactly one entry gets tier 'default': the picker auto-selects it.
    const defaultId =
      PREFERRED_DEFAULTS.find((id) =>
        usable.some((model) => model.id === id)
      ) ??
      cheapestId(usable) ??
      usable[0]?.id;

    const models: ModelAvailability[] = usable.map((model) => ({
      id: `abacus/${model.id}`,
      // Both routers are "RouteLLM" in the picker: the person is choosing the
      // router over a specific model, not a tier of machinery.
      label: ROUTER_IDS.has(model.id)
        ? ROUTER_LABEL
        : (model.display_name ?? model.name ?? model.id),
      provider: "abacus",
      tier: tierFor(model, model.id === defaultId, freeTierAccount),
      note:
        model.free === true
          ? FREE_MODEL_NOTE
          : freeTierAccount
            ? "Included with your Abacus.AI free plan"
            : noteFor(model),
      requiresEnv: ENV_VAR,
      configured: hasCredential(ENV_VAR),
    }));

    // Catalog order is kept: the server sends a deliberate tier-shaped lineup.

    cache = models;

    return models;
  } catch {
    // Offline, timed out, or a shape we don't recognise.
    return withCurrentConfigured(cache);
  }
};

/** Cached list, if a fetch already succeeded this run. */
export const cachedAbacusModels = (): ModelAvailability[] =>
  withCurrentConfigured(cache);

/**
 * `configured` must reflect the key as it is *now*, not as it was when the
 * catalog was fetched: the cache outlives key saves and removals, and a frozen
 * value would keep offering models the user can no longer run (or vice versa).
 */
const withCurrentConfigured = (
  models: ModelAvailability[] | null
): ModelAvailability[] => {
  if (models == null) return [];
  const configured = hasCredential(ENV_VAR);

  return models.map((model) =>
    model.configured === configured ? model : { ...model, configured }
  );
};

let accountCache: { value: AbacusAccountInfo; at: number } | null = null;

export const clearAbacusCache = (): void => {
  cache = null;
  accountCache = null;
  // A new key deserves a fresh verdict.
  credentialRejected = false;
};

/**
 * Who the stored key belongs to, from GET /v1/account. Cached for a minute:
 * two panels ask on open and the numbers move per conversation, not per click.
 * Null (never a throw) when there is no key, it stopped working, or the host
 * is unreachable; callers render "not signed in".
 */
const ACCOUNT_CACHE_MS = 60_000;

/** A valid Abacus session when the deployment keeps profile fields private. */
const connectedAccountWithoutProfile = (): AbacusAccountInfo => ({
  user_id: null,
  organization_id: null,
  name: null,
  email: null,
  picture: null,
  organization: null,
  org_user_count: null,
  plan: null,
  subscription_tier: null,
  credits_used: null,
  credits_granted: null,
});

const MAX_PROFILE_PICTURE_BYTES = 2 * 1024 * 1024;
const PROFILE_PICTURE_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

/** Keep remote profile media out of the renderer's network/CSP boundary. */
const fetchProfilePicture = async (
  value: string | null | undefined
): Promise<string | null> => {
  if (value == null || value.length === 0) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== "https:") return null;

    const response = await fetch(url, {
      signal: AbortSignal.timeout(5000),
    });
    const type = response.headers.get("content-type")?.split(";", 1)[0];
    const declaredSize = Number(response.headers.get("content-length") ?? 0);
    if (
      !response.ok ||
      type == null ||
      !PROFILE_PICTURE_TYPES.has(type) ||
      declaredSize > MAX_PROFILE_PICTURE_BYTES
    ) {
      return null;
    }

    const bytes = Buffer.from(await response.arrayBuffer());
    if (bytes.byteLength > MAX_PROFILE_PICTURE_BYTES) return null;

    return `data:${type};base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
};

export const fetchAbacusAccount = async (
  refresh = false
): Promise<AbacusAccountInfo | null> => {
  const key = resolveKey();
  if (key == null || key.length === 0) {
    accountCache = null;

    return null;
  }
  if (
    !refresh &&
    accountCache != null &&
    Date.now() - accountCache.at < ACCOUNT_CACHE_MS
  ) {
    return accountCache.value;
  }

  try {
    const response = await fetch(`${abacusRoutellmV1()}/account`, {
      headers: {
        Authorization: `Bearer ${key}`,
        "user-agent": abacusUserAgent(),
      },
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      // /account is not in every deployment; an authenticated /models call
      // still tells a connected user from an invalid key.
      if (response.status !== 404 && response.status !== 405) {
        if (REJECTED_STATUSES.has(response.status)) {
          credentialRejected = true;
          accountCache = null;

          return null;
        }

        return accountCache?.value ?? null;
      }

      const modelsResponse = await fetch(`${abacusRoutellmV1()}/models`, {
        headers: {
          Authorization: `Bearer ${key}`,
          "user-agent": abacusUserAgent(),
        },
        signal: AbortSignal.timeout(8000),
      });
      if (!modelsResponse.ok) return accountCache?.value ?? null;

      const value = connectedAccountWithoutProfile();
      accountCache = { value, at: Date.now() };

      return value;
    }

    const body = (await response.json()) as Partial<AbacusAccountInfo> & {
      user_id?: unknown;
      organization_id?: unknown;
    };
    const identity = (value: unknown): string | null =>
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : null;
    const value: AbacusAccountInfo = {
      user_id: identity(body.user_id),
      organization_id: identity(body.organization_id),
      name: body.name ?? null,
      email: body.email ?? null,
      picture: await fetchProfilePicture(body.picture),
      organization: body.organization ?? null,
      org_user_count: body.org_user_count ?? null,
      plan: body.plan ?? null,
      subscription_tier: body.subscription_tier ?? null,
      credits_used: body.credits_used ?? null,
      credits_granted: body.credits_granted ?? null,
    };
    accountCache = { value, at: Date.now() };

    return value;
  } catch {
    return accountCache?.value ?? null;
  }
};
