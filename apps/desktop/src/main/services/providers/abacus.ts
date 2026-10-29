import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { writeFileAtomicSync } from "@abacus-ai/agent/atomic-file";
import {
  ABACUS_ACCOUNT_FOCI,
  ABACUS_PAYMENT_REASONS,
  type AbacusAccountInfo,
  type AbacusPaymentRequired,
} from "@abacus-ai/contract/contracts";
import {
  isPayingAbacusTier,
  type ModelAvailability,
  type ModelTier,
} from "@abacus-ai/contract/models";

import { abacusBotHome } from "../../paths";
import { credentialFor, hasCredential } from "../config/settings";
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
const FREE_MODEL_NOTE = "Free: doesn't use credits";

let cache: ModelAvailability[] | null = null;

/**
 * The account's last fetched list on disk, so a start without a network shows
 * the models it had rather than none. Keyed by a hash of the key.
 */
const lastGoodFile = (key: string): string =>
  path.join(
    abacusBotHome(),
    "abacus-models",
    `${createHash("sha256").update(key).digest("hex").slice(0, 16)}.json`
  );

const readLastGood = (key: string): ModelAvailability[] | null => {
  try {
    const parsed: unknown = JSON.parse(
      fs.readFileSync(lastGoodFile(key), "utf8")
    );
    return Array.isArray(parsed) && parsed.length > 0
      ? (parsed as ModelAvailability[])
      : null;
  } catch {
    // Never fetched on this machine: nothing to fall back on.
    return null;
  }
};

const writeLastGood = (key: string, models: ModelAvailability[]): void => {
  try {
    writeFileAtomicSync(lastGoodFile(key), JSON.stringify(models), {
      restrict: true,
      skipIfUnchanged: true,
    });
  } catch {
    // A lost copy costs only the offline fallback.
  }
};

/**
 * Has the platform refused the key we hold? A timeout or 500 means "ask again
 * later"; a 401/403 means the key is over and retrying cannot help. Kept
 * apart from the caches because it is the one failure the app must act on.
 */
let credentialRejected = false;

/** Whether the stored key has been refused outright. See `credentialRejected`. */
export const abacusCredentialRejected = (): boolean => credentialRejected;

/**
 * The platform's payment gate (HTTP 402) refused the stored key: the key is
 * good, but the account must pay before Abacus serves it. Not a sign-out.
 */
let paymentRequired: AbacusPaymentRequired | null = null;

/** The payment gate's verdict on the stored key, as of the last read. */
export const abacusPaymentRequired = (): AbacusPaymentRequired | null =>
  paymentRequired;

/** The verdict last announced, so a cache clear followed by the same answer stays quiet. */
let announcedPayment: string | null = null;
const paymentListeners = new Set<() => void>();

/** Hears the payment gate's verdict change, whichever read saw it. */
export function onAbacusPaymentChange(listener: () => void): () => void {
  paymentListeners.add(listener);
  return () => {
    paymentListeners.delete(listener);
  };
}

const setPaymentRequired = (next: AbacusPaymentRequired | null): void => {
  paymentRequired = next;
  const verdict = next == null ? null : (next.reason ?? "unknown");
  if (verdict === announcedPayment) return;
  announcedPayment = verdict;
  for (const listener of Array.from(paymentListeners)) listener();
};

/** The 402's `reason`; null when the body carries none we know. */
const paymentReasonOf = async (
  response: Response
): Promise<AbacusPaymentRequired> => {
  const body = (await response.json().catch(() => null)) as {
    reason?: unknown;
  } | null;
  return {
    reason:
      ABACUS_PAYMENT_REASONS.find((reason) => reason === body?.reason) ?? null,
  };
};

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

/** The payment gate: the key is valid, the account has to pay first. */
const PAYMENT_REQUIRED_STATUS = 402;

const abacusHeaders = (key: string) => ({
  Authorization: `Bearer ${key}`,
  "user-agent": abacusUserAgent(),
});

/** Through `credentialFor`, so the signed-in key wins over a shell export. */
const resolveKey = (): string | undefined => {
  const key = credentialFor(ENV_VAR);

  return key.length > 0 ? key : undefined;
};

/** The Abacus key, for main-process callers outside the model provider. */
export const resolveAbacusApiKey = (): string | null => resolveKey() ?? null;

export const fetchAbacusModels = async (): Promise<ModelAvailability[]> => {
  const key = resolveKey();

  if (key == null || key.length === 0) return [];

  try {
    const response = await fetch(`${abacusRoutellmV1()}/models`, {
      headers: abacusHeaders(key),
      signal: AbortSignal.timeout(8000),
    });

    if (!response.ok) {
      if (REJECTED_STATUSES.has(response.status)) {
        credentialRejected = true;
        return withCurrentConfigured(cache);
      }
      // Every call on this key would answer 402 too: offer none of them.
      if (response.status === PAYMENT_REQUIRED_STATUS) {
        setPaymentRequired(await paymentReasonOf(response));
        return [];
      }

      return withCurrentConfigured(cache ?? readLastGood(key));
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
    if (models.length > 0) writeLastGood(key, models);

    return models;
  } catch {
    // Offline, timed out, or a shape we don't recognise.
    return withCurrentConfigured(cache ?? readLastGood(key));
  }
};

/**
 * Models the platform refused for the account's plan at run time, for the
 * key and plan tier they were refused on. The refusal outranks the live list
 * while the plan is the same (the platform said no to this very call); a new
 * key or a new tier starts clean, so an upgrade lifts every lock at once.
 */
interface PlanLocks {
  key: string;
  tier: string | null;
  ids: string[];
}

const planLocksFile = (key: string): string =>
  lastGoodFile(key).replace(/\.json$/, ".plan-locked.json");

let planLocks: PlanLocks | null = null;

const currentTier = (): string | null =>
  accountCache?.value.subscription_tier ?? null;

const readPlanLocks = (key: string): PlanLocks | null => {
  if (planLocks?.key === key) return planLocks;
  try {
    const parsed = JSON.parse(
      fs.readFileSync(planLocksFile(key), "utf8")
    ) as Partial<PlanLocks>;
    planLocks = {
      key,
      tier: typeof parsed.tier === "string" ? parsed.tier : null,
      ids: Array.isArray(parsed.ids)
        ? parsed.ids.filter((id): id is string => typeof id === "string")
        : [],
    };
  } catch {
    // Nothing refused on this machine yet.
    planLocks = { key, tier: currentTier(), ids: [] };
  }
  return planLocks;
};

/** The `abacus/…` ids the account's plan refused, while it is on that plan. */
export const planLockedAbacusIds = (): ReadonlySet<string> => {
  const key = resolveKey();
  if (key == null) return new Set();
  const locks = readPlanLocks(key);
  const tier = currentTier();
  // A tier read since the refusal that differs from it: the plan changed.
  // Refused before any tier was read: lifted once the account reads paying.
  const planChanged =
    tier != null &&
    (locks.tier != null ? tier !== locks.tier : isPayingAbacusTier(tier));
  return planChanged ? new Set() : new Set(locks.ids);
};

/** Records that the platform refused `id` (an `abacus/…` id) for the plan. */
export const lockAbacusModelForPlan = (id: string): void => {
  const key = resolveKey();
  if (key == null || !id.startsWith("abacus/")) return;
  const tier = currentTier();
  const known = planLockedAbacusIds();
  if (known.has(id)) return;
  planLocks = { key, tier, ids: [...known, id] };
  try {
    writeFileAtomicSync(
      planLocksFile(key),
      JSON.stringify({ tier, ids: planLocks.ids }),
      { restrict: true }
    );
  } catch {
    // Lost only across a restart: the next refusal records it again.
  }
};

/** The model a failed turn's card says the plan does not include. */
export const planRefusedModel = (error?: {
  actions?: ReadonlyArray<{ type: string; cause?: string; model?: string }>;
}): string | null =>
  error?.actions?.find(
    (action) => action.type === "model-unavailable" && action.cause === "plan"
  )?.model ?? null;

/** Cached list, if a fetch already succeeded this run; none while the account must pay. */
export const cachedAbacusModels = (): ModelAvailability[] =>
  paymentRequired != null ? [] : withCurrentConfigured(cache);

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

/** What is left of the account's credits, as of one read. */
export interface CreditSnapshot {
  remaining: number;
  granted: number;
  at: number;
}

const snapshotOf = (
  cached: { value: AbacusAccountInfo; at: number } | null
): CreditSnapshot | null => {
  if (cached == null) return null;
  const { credits_used: used, credits_granted: granted } = cached.value;
  if (used == null || granted == null || granted <= 0) return null;
  return { remaining: Math.max(0, granted - used), granted, at: cached.at };
};

/** The credit balance as of the last account read; null without one. */
export const creditSnapshot = (): CreditSnapshot | null =>
  snapshotOf(accountCache);

const accountReadListeners = new Set<(snapshot: CreditSnapshot) => void>();

/** Hears every fresh account read that carries a balance. */
export function onAbacusAccountRead(
  listener: (snapshot: CreditSnapshot) => void
): () => void {
  accountReadListeners.add(listener);
  return () => {
    accountReadListeners.delete(listener);
  };
}

const remember = (value: AbacusAccountInfo): void => {
  accountCache = { value, at: Date.now() };
  const snapshot = snapshotOf(accountCache);
  if (snapshot != null)
    for (const listener of Array.from(accountReadListeners)) listener(snapshot);
};

/**
 * The platform says the account just moved to `plan` (a payment landed):
 * its tier is taken at once, so what the plan unlocks (tools, routines, the
 * pitch) reads right in the very next turn, and every account listener hears
 * it; the model catalog is dropped and the account read afresh behind it.
 */
export const accountMovedPlan = (plan: string | null): void => {
  const tier = plan?.trim().toLowerCase() ?? "";
  if (accountCache != null && tier.length > 0)
    remember({ ...accountCache.value, subscription_tier: tier });
  cache = null;
  void fetchAbacusAccount(true).catch(() => null);
};

export const clearAbacusCache = (): void => {
  cache = null;
  accountCache = null;
  // A new key deserves a fresh verdict.
  credentialRejected = false;
  paymentRequired = null;
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

/** One /v1/account read for a key, with nothing cached. */
type AccountRead =
  | { kind: "account"; value: AbacusAccountInfo }
  | { kind: "rejected" }
  | { kind: "payment-required"; payment: AbacusPaymentRequired }
  | { kind: "unavailable" };

/** Who `key` belongs to, read now. Never a throw: a failure is `unavailable`. */
export const requestAbacusAccount = async (
  key: string
): Promise<AccountRead> => {
  try {
    const response = await fetch(`${abacusRoutellmV1()}/account`, {
      headers: abacusHeaders(key),
      signal: AbortSignal.timeout(8000),
    });
    if (!response.ok) {
      console.warn(`[abacus] /account answered ${response.status}`);
      if (REJECTED_STATUSES.has(response.status)) return { kind: "rejected" };
      if (response.status === PAYMENT_REQUIRED_STATUS)
        return {
          kind: "payment-required",
          payment: await paymentReasonOf(response),
        };
      // /account is not in every deployment; an authenticated /models call
      // still tells a connected user from an invalid key.
      if (response.status !== 404 && response.status !== 405)
        return { kind: "unavailable" };

      const modelsResponse = await fetch(`${abacusRoutellmV1()}/models`, {
        headers: abacusHeaders(key),
        signal: AbortSignal.timeout(8000),
      });
      return modelsResponse.ok
        ? { kind: "account", value: connectedAccountWithoutProfile() }
        : { kind: "unavailable" };
    }

    const body = (await response.json()) as Partial<AbacusAccountInfo> & {
      user_id?: unknown;
      organization_id?: unknown;
    };
    const identity = (value: unknown): string | null =>
      typeof value === "string" || typeof value === "number"
        ? String(value)
        : null;
    return {
      kind: "account",
      value: {
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
        web_signup: body.web_signup === true,
        google_sign_in: body.google_sign_in === true,
        // Only a server that says so: an older one sends nothing.
        ...(typeof body.free_credits_held === "boolean"
          ? { free_credits_held: body.free_credits_held }
          : {}),
        focus:
          ABACUS_ACCOUNT_FOCI.find((focus) => focus === body.focus) ?? null,
        onboarding_offer: body.onboarding_offer === true,
      },
    };
  } catch {
    return { kind: "unavailable" };
  }
};

export const fetchAbacusAccount = async (
  refresh = false
): Promise<AbacusAccountInfo | null> => {
  const key = resolveKey();
  if (key == null || key.length === 0) {
    accountCache = null;
    setPaymentRequired(null);

    return null;
  }
  if (
    !refresh &&
    accountCache != null &&
    Date.now() - accountCache.at < ACCOUNT_CACHE_MS
  ) {
    return accountCache.value;
  }

  const read = await requestAbacusAccount(key);
  switch (read.kind) {
    case "account":
      setPaymentRequired(null);
      remember(read.value);
      return read.value;
    case "rejected":
      credentialRejected = true;
      accountCache = null;
      return null;
    case "payment-required":
      // Signed in, but nothing on this account runs until it pays.
      accountCache = null;
      setPaymentRequired(read.payment);
      return null;
    case "unavailable":
      return accountCache?.value ?? null;
  }
};

/** The account as last read, without a fetch: null before the first read or once signed out. */
export const cachedAbacusAccount = (): AbacusAccountInfo | null =>
  accountCache?.value ?? null;

/** Whether the account is on the free plan: its tier, else its plan, reads "free". */
export const onFreePlan = (
  account: Pick<AbacusAccountInfo, "plan" | "subscription_tier"> | null
): boolean =>
  (
    account?.subscription_tier?.trim() || account?.plan?.trim()
  )?.toLowerCase() === "free";
