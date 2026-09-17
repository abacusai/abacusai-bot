/**
 * OpenLLM: one picker entry standing for "every model I can run for free right
 * now" — Abacus's cheap drivers, a Studio key's daily quota, OpenRouter's
 * `:free` tier. The sources fail independently, so pooled with automatic
 * fallback they keep the agent working. The id is virtual: never sent
 * to pi's fuzzy-matching resolver, the session swaps in a concrete free model.
 */
import type { CooldownStore } from "./openllm-cooldowns.js";
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

/** Out of paid-for capacity, as providers phrase it — not a mere rate limit. */
export function isOutOfCredits(raw: string): boolean {
  const status = raw.match(/^\s*(\d{3})\b/)?.[1];
  if (status === "402") return true;
  // Credit gates phrase it these ways, 429s included; an exhausted account
  // must never read as a mere rate limit.
  return /no remaining credits|insufficient credit|out of credit|credit limit|quota exceeded|purchase more credits|high percentage of your (overall )?credits/i.test(
    raw
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
  // An exhausted Abacus balance refuses every billed model alike; the $0 ones
  // (a stealth preview) still serve, so the pool hops straight to them.
  if (provider === "abacus") {
    return isOutOfCredits(failure) ? { provider: "abacus", free: false } : null;
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
 * The pool's sources, in the order tried. Abacus first: paid for, tuned for
 * agent loops, and never free-tier rate-limited. Then a Studio key's Gemini
 * quota, then OpenRouter's `:free` models.
 */
const SOURCE_RANK: Record<string, number> = {
  abacus: 0,
  gemini: 1,
  openrouter: 2,
};

/**
 * Abacus's CHAT router, never pooled: above 5000 tokens of context it
 * short-circuits to a Flash model, which an agent passes on its system prompt
 * alone — see CHAT_ROUTER_ID in providers.ts.
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
  choice.free && choice.modelId.endsWith(":free");

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

  return choice.provider === "gemini";
};

/**
 * Order within the Abacus slice: the platform's, from the catalog's
 * `route-llm-open` entry (see providers.ts), so a reorder, a new $0 model or
 * a retired one never waits on an app release. Unranked members trail.
 */
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
        (SOURCE_RANK[a.provider] ?? 99) - (SOURCE_RANK[b.provider] ?? 99) ||
        abacusRank(a) - abacusRank(b) ||
        familyRank(a) - familyRank(b) ||
        b.contextWindow - a.contextWindow ||
        a.label.localeCompare(b.label)
    );
}

/** How a scope is stored: the provider, plus the tier when tier-specific. */
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
    private readonly store?: CooldownStore
  ) {
    for (const [id, entry] of Object.entries(store?.read() ?? {})) {
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
    this.scopeUntil.set(scopeKey(scope), this.now() + cooldownMs);
  }

  /**
   * Forget every cooldown. Called when the account's situation changed under
   * us — a key added, credits topped up, a plan upgraded — where the reason a
   * model or a whole provider was sidelined may no longer hold.
   */
  clearCooldowns(): void {
    for (const id of this.cooldownUntil.keys()) {
      this.store?.write({ [id]: { until: 0, failures: 0 } });
    }
    this.cooldownUntil.clear();
    this.failures.clear();
    this.scopeUntil.clear();
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
    const eligible = candidates.filter(
      (choice) => !exclude?.has(choice.id) && !this.inRefusedScope(choice, now)
    );

    const ready = eligible.find(
      (choice) => (this.cooldownUntil.get(choice.id) ?? 0) <= now
    );

    if (ready != null) return ready;

    let soonest: ModelChoice | undefined;
    let soonestAt = Infinity;

    for (const choice of eligible) {
      const at = this.cooldownUntil.get(choice.id) ?? 0;

      if (at < soonestAt) {
        soonest = choice;
        soonestAt = at;
      }
    }

    return soonest;
  }
}
