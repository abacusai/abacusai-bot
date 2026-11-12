/**
 * OpenLLM: one picker entry standing for "every model I can run for free right
 * now": Abacus's cheap drivers, a Studio key's daily quota, OpenRouter's
 * `:free` tier. The sources fail independently, so pooled with automatic
 * fallback they keep the agent working. The id is virtual: never sent
 * to pi's fuzzy-matching resolver, the session swaps in a concrete free model.
 */
import { listedModelRank, sourceRank } from "./free-sources.js";
import type { CooldownStore } from "./openllm-cooldowns.js";
import { openRouterTakesTools } from "./openrouter-live.js";
import type { ModelChoice } from "./providers.js";

/** Must match the `openllm/auto` entry in the desktop catalog. */
export const OPENLLM_ID = "openllm/auto";

export const isOpenLlmReference = (
  reference: string | null | undefined
): boolean => reference?.trim() === OPENLLM_ID;

/**
 * How long a failed model sits out. Free-tier 429s are quota resets measured in
 * minutes; retrying within the same minute burns a rotation slot for nothing.
 */
export const OPENLLM_COOLDOWN_MS = 5 * 60_000;

/**
 * The wait grows with consecutive failures and stops at an hour: a flat five
 * minutes puts an all-day-saturated model back at the front of the order twelve
 * times an hour, each time costing a failed request and a rotation slot. One
 * success clears the count.
 */
export const OPENLLM_COOLDOWN_STEPS_MS = [
  OPENLLM_COOLDOWN_MS,
  15 * 60_000,
  60 * 60_000,
];

/** The wait after `failures` consecutive failures, counting this one. */
export const cooldownForFailures = (failures: number): number =>
  OPENLLM_COOLDOWN_STEPS_MS[
    Math.min(Math.max(failures, 1), OPENLLM_COOLDOWN_STEPS_MS.length) - 1
  ] ?? OPENLLM_COOLDOWN_MS;

/**
 * How long a whole class of models sits out after the account refuses it.
 * Longer than a model's cooldown because a daily quota or an empty wallet does
 * not recover in five minutes; not "until the reset" because the reset instant
 * arrives in a header this code never sees.
 */
export const OPENLLM_ACCOUNT_COOLDOWN_MS = 60 * 60_000;

/**
 * A class of models one failure condemns. `free` narrows it to one tier:
 * OpenRouter's free quota and its credit balance are separate accounts.
 */
export interface FailureScope {
  provider: string;
  free?: boolean;
}

/**
 * The HTTP status a failure carries: up front (`429: …`), else inside a bare
 * JSON body (`{"error":{"code":429}}`) or named in prose (`HTTP 429`).
 */
export function failureStatus(raw: string): string | undefined {
  return (
    raw.match(/^\s*(\d{3})\b/)?.[1] ??
    raw.match(/^\s*[[{][\s\S]*?"(?:code|status)"\s*:\s*"?(\d{3})\b/)?.[1] ??
    raw.match(/\b(?:HTTP|status(?: code)?)\s*:?\s*(\d{3})\b/i)?.[1]
  );
}

/**
 * Why the Abacus credit gate refused a turn: `expired` is a free tier past
 * its window; `exhausted` is every other refusal, an empty balance included.
 */
export type CreditWall = "exhausted" | "expired";

/**
 * The credit wall a failure names, or null when it names none. Generic quota
 * and "credit limit" text is left out: providers use it for rate limits and
 * for the user's own key, neither of which an Abacus plan answers. A 402 is
 * read as exhausted whoever sent it; callers gate the card on Abacus serving.
 */
export function creditWall(raw: string): CreditWall | null {
  // First: the expiry sentence keeps "no remaining credits" for old clients.
  if (
    /credits have expired|free (tier|credits?) (has|have)? ?expired/i.test(raw)
  ) {
    return "expired";
  }
  if (failureStatus(raw) === "402") return "exhausted";
  return /no remaining credits|no credits remaining|insufficient credit|out of credits?|purchase more credits|high percentage of your (overall )?credits/i.test(
    raw
  )
    ? "exhausted"
    : null;
}

/**
 * The platform refusing a model the account's plan does not include (a free
 * key asking for a paid model), as opposed to the key itself being bad: the
 * same key runs every model its own /v1/models lists.
 */
export function isPlanRejection(raw: string): boolean {
  return /not available on (?:the|your) (?:free tier|plan)|not included in your plan/i.test(
    raw
  );
}

/** Out of Abacus credits for any reason: never a mere rate limit. */
export const isOutOfCredits = (raw: string): boolean => creditWall(raw) != null;

/**
 * Why Abacus refused a call for its account rather than for the request:
 * the credits (`exhausted`, `expired`), the billing (`payment`, a payment
 * not confirmed or a subscription that lapsed), or free credits held until
 * the account verifies a phone (`unverified`).
 */
export type AbacusRefusal = CreditWall | "payment" | "unverified";

/** The code the server puts on each such refusal, in the body and a header. */
const ABACUS_REFUSAL_CODE =
  /\babacus_(credits_exhausted|free_tier_expired|payment_required|credits_not_activated)\b/;

const REFUSAL_BY_CODE: Record<string, AbacusRefusal> = {
  credits_exhausted: "exhausted",
  free_tier_expired: "expired",
  payment_required: "payment",
  credits_not_activated: "unverified",
};

/** The billing gate's 402 sentences, for a server that sends no code. */
const PAYMENT_REFUSAL =
  /could not confirm the last payment|subscription has ended|payment method is required|PaymentMethodRequired/i;
/** The same gate's 402 for a free tier past its end, without a code. */
const TRIAL_ENDED = /free trial has ended/i;

/**
 * Calls the Abacus endpoint answered: Abacus itself, and a call whose
 * provider is not known (as before the provider was recorded).
 */
const abacusServed = (provider: string | undefined): boolean =>
  provider == null || provider === "abacus" || provider === "openllm";

/**
 * Why Abacus refused this call for credits or billing, or null. Only a call
 * Abacus served can say so: another provider's balance or quota sentence is
 * the user's own key, which no Abacus plan refills. The code decides; an
 * answer without one (an older server, an edge error) is read by its words.
 */
export function abacusRefusal(
  raw: string,
  provider: string | undefined
): AbacusRefusal | null {
  if (!abacusServed(provider)) return null;
  const code = raw.match(ABACUS_REFUSAL_CODE)?.[1];
  if (code != null) return REFUSAL_BY_CODE[code] ?? null;
  if (PAYMENT_REFUSAL.test(raw)) return "payment";
  if (TRIAL_ENDED.test(raw)) return "expired";
  return creditWall(raw);
}

/** Where an account verifies its phone, when the refusal names no page of its own. */
export const VERIFY_PHONE_URL = "https://apps.abacus.ai/bot/link/verify-phone";

/**
 * The phone-verification refusal's page and the free credits it unlocks, as
 * the server's sentence names them ("Verify your phone to unlock 2,000 free
 * credits: <link>"). Only an Abacus page is taken; anything else, or none,
 * is the default page. The credits are null when the sentence names none.
 */
export function phoneVerification(raw: string): {
  link: string;
  credits: string | null;
} {
  const found = raw.match(/https:\/\/[^\s"'\\<>]+/)?.[0];
  let link = VERIFY_PHONE_URL;
  if (found != null) {
    try {
      const host = new URL(found).hostname;
      if (host === "abacus.ai" || host.endsWith(".abacus.ai")) link = found;
    } catch {
      // Not a URL after all: the default page.
    }
  }
  const credits = raw.match(/unlock ([\d.,]+) free credits/i)?.[1] ?? null;
  return { link, credits };
}

/** A billing refusal's reason: a lapsed subscription, else an unconfirmed payment. */
export const paymentRefusalReason = (raw: string): "lapsed" | "unconfirmed" =>
  /subscription has ended|"reason"\s*:\s*"lapsed"/i.test(raw)
    ? "lapsed"
    : "unconfirmed";

/**
 * Balance and billing sentences that never mean a rate limit, whoever relays
 * them: Anthropic's 400 "credit balance is too low", OpenAI's 429
 * `insufficient_quota`, DeepSeek's 402 "Insufficient Balance", xAI's "used all
 * available credits".
 */
const OWN_KEY_BALANCE_PATTERN =
  /credit balance is too low|insufficient_quota|insufficient balance|used all (?:of )?(?:its |your )?available credits/i;

/** A provider's sentence about an empty balance, on any status code. */
export const namesEmptyBalance = (raw: string): boolean =>
  OWN_KEY_BALANCE_PATTERN.test(raw);

/**
 * Gemini answers a per-minute rate limit and a spent quota alike with 429
 * RESOURCE_EXHAUSTED "exceeded your current quota ... check your plan and
 * billing details", so only the prepaid wallet's own wording counts.
 */
const GEMINI_BALANCE_PATTERN =
  /prepayment|credits? (?:are |is |have been )?(?:depleted|exhausted)|credit balance/i;

/**
 * A turn on the user's own key (any provider but Abacus and the router) that
 * stopped because that key's account has no credit left: what the app can
 * answer with an Abacus plan rather than a red line. Never a rate limit or a
 * transient error, so it reads each provider's own phrasing: a 402 anywhere;
 * Anthropic, DeepSeek, OpenRouter and xAI by their balance sentences; OpenAI
 * by `insufficient_quota` or "exceeded your current quota"; Gemini only when
 * the text names its prepaid credits.
 */
export function isOwnKeyOutOfCredit(
  raw: string,
  provider: string | undefined
): boolean {
  if (provider == null || provider === "abacus" || provider === "openllm") {
    return false;
  }

  const status = failureStatus(raw);

  if (status === "402") return true;

  if (provider === "gemini") return GEMINI_BALANCE_PATTERN.test(raw);

  return (
    namesEmptyBalance(raw) ||
    (provider === "openai" && /exceeded your current quota/i.test(raw)) ||
    /credit limit/i.test(raw) ||
    isOutOfCredits(raw)
  );
}

/**
 * The class a provider error condemns, or null when it only condemns the model.
 * An account failure (`free-models-per-day` is one allowance shared by every
 * `:free` model; an empty balance is the same on the paid side) fails the same
 * way on every sibling, so rotating would show the user the same sentence five
 * times. Read from the text because that is all that reaches us.
 */
export function accountWideFailure(
  failure: string,
  provider: string | undefined
): FailureScope | null {
  // An exhausted Abacus balance is refused before any model is looked at: the
  // gate is the organization's, so the $0 models answer with the same sentence
  // as the billed ones. Closing only the paid tier left those to fail one by
  // one on per-model cooldowns, which then read as "busy" rather than "shut".
  if (provider === "abacus") {
    return abacusRefusal(failure, provider) != null
      ? { provider: "abacus" }
      : null;
  }

  // A Studio key's free quota is the key's, not one model's: Google says so
  // with RESOURCE_EXHAUSTED / "exceeded your current quota" on a 429, which a
  // plain per-model rate limit does not carry.
  if (provider === "gemini") {
    return /\b429\b/.test(failure) &&
      /resource_exhausted|exceeded your current quota|quota exceeded/i.test(
        failure
      )
      ? { provider: "gemini" }
      : null;
  }

  if (provider !== "openrouter") return null;

  // One allowance across every free model on the key, not a per-model limit.
  if (/free-models-per-day/i.test(failure)) {
    return { provider: "openrouter", free: true };
  }

  // No paid model can run without credit, whichever one is asked.
  if (
    /\b402\b/.test(failure) &&
    /insufficient credits|never purchased credits|purchase (?:more|credits)/i.test(
      failure
    )
  ) {
    return { provider: "openrouter", free: false };
  }

  return null;
}

/**
 * Abacus's CHAT router, never pooled: above 5000 tokens of context it
 * short-circuits to a Flash model, which an agent passes on its system prompt
 * alone. See CHAT_ROUTER_ID in providers.ts.
 */
const ABACUS_CHAT_ROUTER = "route-llm";

/**
 * Families with a record of driving an agent loop, best first, matched against
 * the OpenRouter model id (`deepseek/deepseek-chat-v3:free`).
 */
const FAMILY_RANK: RegExp[] = [
  /deepseek/i,
  /qwen[^/]*coder|coder[^/]*qwen/i,
  /kimi/i,
  /glm/i,
  /qwen/i,
  /llama/i,
  /gemma/i,
  /mistral|devstral/i,
];

const familyRank = (choice: ModelChoice): number => {
  const index = FAMILY_RANK.findIndex((family) => family.test(choice.modelId));

  return index === -1 ? FAMILY_RANK.length : index;
};

/**
 * `choice.free` alone is not the test: a model with no published price arrives
 * as cost zero, so it is true for paid models nobody priced (`openrouter/auto`
 * among them), which 402 on a key with no credits. The `:free` suffix is what
 * OpenRouter states rather than implies; an unknown price is no evidence.
 */
const isOpenRouterFreeTier = (choice: ModelChoice): boolean =>
  choice.free &&
  choice.modelId.endsWith(":free") &&
  openRouterTakesTools(choice.modelId);

/**
 * Whether one model is in the pool. Gemini qualifies as a whole: its catalog
 * cost is the paid rate, but a Studio key serves it under a daily free quota.
 * Abacus qualifies by the provider's poolEligible flag rather than a price
 * test, since rates drift past any hardcoded ceiling.
 */
const inPool = (choice: ModelChoice): boolean => {
  if (choice.provider === "openrouter") return isOpenRouterFreeTier(choice);
  if (choice.provider === "abacus") {
    return (
      choice.modelId !== ABACUS_CHAT_ROUTER && choice.poolEligible === true
    );
  }

  if (choice.provider === "gemini") return true;

  // The rest pool the models their row in free-sources.ts lists.
  return listedModelRank(choice.provider, choice.modelId) !== -1;
};

/**
 * Order within the Abacus slice: the platform's, from the catalog's
 * `route-llm-open` entry (see providers.ts), so a reorder, a new $0 model or
 * a retired one never waits on an app release. Unranked members trail.
 */
/** A listed source's own order (free-sources.ts); zero for the rest. */
const listedRank = (choice: ModelChoice): number =>
  Math.max(0, listedModelRank(choice.provider, choice.modelId));

const abacusRank = (choice: ModelChoice): number => {
  if (choice.provider !== "abacus") return 0;

  return choice.poolRank ?? Number.MAX_SAFE_INTEGER;
};

/**
 * The models OpenLLM may route to, best first: by source, then family within
 * OpenRouter, then context window (a transcript outgrows a small one fast),
 * then label so the order is stable run to run.
 */
export function openLlmCandidates(models: ModelChoice[]): ModelChoice[] {
  return models
    .filter(inPool)
    .sort(
      (a, b) =>
        sourceRank(a.provider) - sourceRank(b.provider) ||
        abacusRank(a) - abacusRank(b) ||
        listedRank(a) - listedRank(b) ||
        familyRank(a) - familyRank(b) ||
        b.contextWindow - a.contextWindow ||
        a.label.localeCompare(b.label)
    );
}

/** How a scope is stored: the provider, plus the tier when tier-specific. */
/** Scope refusals share the cooldown file under this prefix; see the constructor. */
const SCOPE_STORE_PREFIX = "scope:";

const scopeKey = (scope: FailureScope): string =>
  `${scope.provider}:${scope.free === undefined ? "all" : scope.free ? "free" : "paid"}`;

/**
 * Which free model to run next, remembering who failed recently. Per session,
 * not per turn: a model that 429ed on the last question is still rate-limited.
 */
export class OpenLlmRotation {
  private readonly cooldownUntil = new Map<string, number>();
  /** Consecutive failures per model, which is what lengthens the next wait. */
  private readonly failures = new Map<string, number>();
  /** Classes the account has refused, keyed provider:tier. See FailureScope. */
  private readonly scopeUntil = new Map<string, number>();

  /**
   * `store` carries cooldowns between sessions, so a new chat does not have to
   * rediscover a saturated model by failing on it.
   */
  constructor(
    private readonly now: () => number = Date.now,
    private readonly store?: CooldownStore,
    /** When a model's quota window reopens (openllm-quota.ts); 0 when open. */
    private readonly quotaBlockedUntil: (choice: ModelChoice) => number = () =>
      0
  ) {
    for (const [id, entry] of Object.entries(store?.read() ?? {})) {
      // A class the account refused is kept the same way, so a new chat
      // opened against a shut pool says so at once instead of failing first.
      if (id.startsWith(SCOPE_STORE_PREFIX)) {
        this.scopeUntil.set(id.slice(SCOPE_STORE_PREFIX.length), entry.until);
        continue;
      }
      this.cooldownUntil.set(id, entry.until);
      this.failures.set(id, entry.failures);
    }
  }

  /**
   * Note that a model failed, and put it out for longer than the last time. An
   * explicit `cooldownMs` wins but does not reset the count.
   */
  markFailed(id: string, cooldownMs?: number): void {
    const failures = (this.failures.get(id) ?? 0) + 1;
    const until = this.now() + (cooldownMs ?? cooldownForFailures(failures));

    this.failures.set(id, failures);
    this.cooldownUntil.set(id, until);
    this.store?.write({ [id]: { until, failures } });
  }

  /**
   * A model answered, so it starts from a clean sheet: otherwise a bad hour
   * weeks ago would still be serving hour-long cooldowns.
   */
  markSucceeded(id: string): void {
    this.failures.delete(id);
    this.cooldownUntil.delete(id);
    this.store?.write({ [id]: { until: 0, failures: 0 } });
  }

  /**
   * Put a whole class out because the account, not the model, said no. Unlike
   * a model's cooldown this is never overridden: every sibling shares the
   * allowance that just ran out.
   */
  markScopeFailed(
    scope: FailureScope,
    cooldownMs = OPENLLM_ACCOUNT_COOLDOWN_MS
  ): void {
    const until = this.now() + cooldownMs;

    this.scopeUntil.set(scopeKey(scope), until);
    this.store?.write({
      [`${SCOPE_STORE_PREFIX}${scopeKey(scope)}`]: { until, failures: 0 },
    });
  }

  /**
   * Forget every cooldown. Called when the account's situation changed under
   * us (a key added, credits topped up, a plan upgraded) where the reason a
   * model or a whole provider was sidelined may no longer hold.
   */
  clearCooldowns(): void {
    for (const id of this.cooldownUntil.keys()) {
      this.store?.write({ [id]: { until: 0, failures: 0 } });
    }
    for (const key of this.scopeUntil.keys()) {
      this.store?.write({
        [`${SCOPE_STORE_PREFIX}${key}`]: { until: 0, failures: 0 },
      });
    }
    this.cooldownUntil.clear();
    this.failures.clear();
    this.scopeUntil.clear();
  }

  /**
   * Whether every candidate is in a class the account refused: the pool is
   * not busy but shut, and waiting will not open it: only a new source will.
   */
  poolShut(candidates: ModelChoice[]): boolean {
    return candidates.length > 0 && this.open(candidates).length === 0;
  }

  /**
   * The candidates whose class the account has not refused: what `pick` can
   * run, now or once a cooldown ends. Anything offered as a way on reads this.
   */
  open(candidates: readonly ModelChoice[]): ModelChoice[] {
    const now = this.now();
    return candidates.filter((choice) => !this.inRefusedScope(choice, now));
  }

  /** Whether the account has this model's class shut for now. */
  private inRefusedScope(choice: ModelChoice, now: number): boolean {
    return (
      (this.scopeUntil.get(scopeKey({ provider: choice.provider })) ?? 0) >
        now ||
      (this.scopeUntil.get(
        scopeKey({ provider: choice.provider, free: choice.free })
      ) ?? 0) > now
    );
  }

  /** The candidate ready soonest and when, ignoring nothing but refused classes. */
  soonest(
    candidates: ModelChoice[]
  ): { id: string; readyAt: number } | undefined {
    let best: { id: string; readyAt: number } | undefined;
    for (const choice of this.open(candidates)) {
      const readyAt = this.readyAt(choice);
      if (best == null || readyAt < best.readyAt)
        best = { id: choice.id, readyAt };
    }
    return best;
  }

  /** When a model may run again: its cooldown over and its quota window open. */
  private readyAt(choice: ModelChoice): number {
    return Math.max(
      this.cooldownUntil.get(choice.id) ?? 0,
      this.quotaBlockedUntil(choice)
    );
  }

  /**
   * The best candidate not cooling down, or when all are, the one whose
   * cooldown expires soonest: "everything failed recently" must not become
   * "no model at all". Empty only when `candidates` (minus `exclude`) is.
   */
  pick(
    candidates: ModelChoice[],
    exclude?: ReadonlySet<string>
  ): ModelChoice | undefined {
    const now = this.now();
    // A class the account refused is dropped outright rather than ranked last:
    // the soonest-expiry fallback is pointless for models sharing an allowance
    // that has run out, and saying so once beats saying it per sibling.
    const eligible = this.open(candidates).filter(
      (choice) => !exclude?.has(choice.id)
    );

    // Out until its cooldown ends and its spent quota window reopens.
    const readyAt = (choice: ModelChoice): number => this.readyAt(choice);
    const ready = eligible.find((choice) => readyAt(choice) <= now);

    if (ready != null) return ready;

    let soonest: ModelChoice | undefined;
    let soonestAt = Infinity;

    for (const choice of eligible) {
      const at = readyAt(choice);

      if (at < soonestAt) {
        soonest = choice;
        soonestAt = at;
      }
    }

    return soonest;
  }
}
