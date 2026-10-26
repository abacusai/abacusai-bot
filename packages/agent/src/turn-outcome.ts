/**
 * How a turn ended, decided once from every model call it made, and what the
 * user is shown for it. Both loops record each call's result in a TurnChain;
 * at the end of the turn the chain names one cause, and presentFailure turns
 * that cause into the error the app draws (the credits card, the connection
 * card, a model switch) and the desktop words for a chat app. Nothing else
 * reads a provider's error text to decide what the user sees.
 */
import {
  failedCallStreamed,
  NETWORK_UNREACHABLE_CODE,
  NETWORK_UNREACHABLE_MESSAGE,
} from "./network-wait.js";
import { networkShaped } from "./openllm-failures.js";
import {
  abacusRefusal,
  accountWideFailure,
  failureStatus,
  isOwnKeyOutOfCredit,
  isPlanRejection,
  namesEmptyBalance,
  paymentRefusalReason,
  phoneVerification,
} from "./openllm.js";
import type { NotificationAction } from "./protocol.js";
import { isStreamCut } from "./stream-cut.js";

/**
 * Why a turn did not finish. One per turn, read from the whole chain of
 * calls, so a turn that met a rate limit and then a dropped connection is
 * the connection's, never "busy".
 */
export type FailureCause =
  /** The Abacus credit gate refused: the balance is spent. */
  | "credits_exhausted"
  /** The Abacus credit gate refused: a free tier past its window. */
  | "credits_expired"
  /** Abacus's billing gate refused: a payment not confirmed, or lapsed. */
  | "payment_required"
  /**
   * Abacus holds the account's free credits until it verifies a phone. Only
   * the user can lift it, so it ends the turn: no retry, no other model.
   */
  | "phone_verification"
  /** The request never reached a server, or its connection died. */
  | "connection"
  /** The transcript does not fit the model's window or size cap. */
  | "context_too_long"
  /** The provider refused the key itself. */
  | "key_invalid"
  /** Abacus refused a model the account's plan does not include. */
  | "not_in_plan"
  /** The user's own key (not Abacus) spent its quota or balance. */
  | "own_key_quota"
  /** The model is gone, cannot take tools, or rejects the request's format. */
  | "model_unavailable"
  /** Every free source refused the account for now. */
  | "free_pool_spent"
  /** A real rate limit or an overloaded provider: worth waiting for. */
  | "rate_limited"
  /** Google closed the reply's stream partway, even after asking again. */
  | "stream_cut"
  /** The model answered with nothing after an earlier call failed. */
  | "empty"
  | "unknown";

/** Providers whose keys are the platform's, not the user's own. */
const PLATFORM_PROVIDERS: ReadonlySet<string> = new Set([
  "abacus",
  "openllm",
  "local",
]);

const ownKey = (provider: string | undefined): provider is string =>
  provider != null && !PLATFORM_PROVIDERS.has(provider);

const KEY_REFUSED =
  /invalid[_ ]api[_ ]key|incorrect api key|api key (?:not valid|is invalid)|no api key|unauthori[sz]ed|authentication|invalid (?:token|credentials)|not allowed for this api/i;
const MODEL_REFUSED =
  /model[_ ]not[_ ]found|model .*(?:does not exist|not found|decommissioned|deprecated)|no endpoints found|is not a valid model|failed to template|chat template|wrote its tool call as text/i;
const DAILY_LIMIT =
  /per day|daily|\brpd\b|\btpd\b|requests? per day|tokens? per day/i;
const BUSY =
  /overloaded|rate.?limit|too many requests|at capacity|server is busy|temporarily unavailable/i;

/** The empty reply's failure text, as both loops record it. */
export const EMPTY_REPLY_FAILURE = "model returned an empty reply";

/** The turn's last call answered with no text and no tool call. */
export function endedEmpty(messages: readonly unknown[]): boolean {
  const last = [...messages]
    .reverse()
    .find(
      (message) => (message as { role?: unknown })?.role === "assistant"
    ) as { stopReason?: unknown } | undefined;
  return (
    last != null &&
    last.stopReason !== "error" &&
    last.stopReason !== "aborted" &&
    !failedCallStreamed(messages)
  );
}

/** What one failed call means, from its error text and its provider. */
export function classifyAttempt(
  raw: string,
  provider: string | undefined
): FailureCause {
  const status = Number(failureStatus(raw) ?? Number.NaN);
  const text = raw.toLowerCase();

  // The credit and billing gates are Abacus's, decided by who refused:
  // another provider's balance sentence is the user's own key.
  const refusal = abacusRefusal(raw, provider);
  if (refusal === "unverified") return "phone_verification";
  if (refusal === "payment") return "payment_required";
  if (refusal === "expired") return "credits_expired";
  if (refusal === "exhausted") return "credits_exhausted";

  if (networkShaped(raw)) return "connection";

  // The key is fine; the plan does not include the model. Before the key
  // and 403 branches, which would send the user to the keys page.
  if (provider === "abacus" && isPlanRejection(raw)) return "not_in_plan";

  if (raw === EMPTY_REPLY_FAILURE) return "empty";

  if (isStreamCut(raw, provider)) return "stream_cut";

  if (
    ownKey(provider) &&
    (isOwnKeyOutOfCredit(raw, provider) ||
      accountWideFailure(raw, provider) != null ||
      (status === 429 && DAILY_LIMIT.test(raw)))
  )
    return "own_key_quota";

  if (status === 401 || KEY_REFUSED.test(raw)) return "key_invalid";

  if (
    status === 413 ||
    REQUEST_TOO_LARGE_PATTERN.test(text) ||
    CONTEXT_LENGTH_PATTERN.test(text)
  )
    return "context_too_long";

  if (
    status === 403 ||
    status === 404 ||
    status === 410 ||
    MODEL_REFUSED.test(raw) ||
    TOOLS_UNSUPPORTED_PATTERN.test(text)
  )
    return "model_unavailable";

  if (status === 429 || status >= 500 || BUSY.test(raw)) return "rate_limited";

  return "unknown";
}

/**
 * Which cause a turn is reported under when its calls failed in several
 * ways: the first in this list that any call met. What the user can act on
 * comes first; "busy" only when nothing more specific happened.
 */
const CAUSE_PRIORITY: readonly FailureCause[] = [
  "phone_verification",
  "credits_exhausted",
  "credits_expired",
  "payment_required",
  "connection",
  "context_too_long",
  "key_invalid",
  "not_in_plan",
  // Every free source refused: connecting another says more than any one
  // source's quota line.
  "free_pool_spent",
  "own_key_quota",
  "model_unavailable",
  "rate_limited",
  "stream_cut",
  "empty",
  "unknown",
];

interface Attempt {
  provider: string | undefined;
  cause: FailureCause | null;
  raw: string;
}

/** The cause a turn ends on, with the call that showed it. */
export interface TurnFailure {
  cause: FailureCause;
  /** The provider of the call that showed the cause. */
  provider: string | undefined;
  /** That call's error text, for the log and the card's details. */
  raw: string;
}

/**
 * Every model call one turn made, in order: what failed, and whether the
 * last one answered. The router feeds it on the free pool; a pinned model's
 * one call goes in the same way.
 */
export class TurnChain {
  private attempts: Attempt[] = [];

  /** A new turn. */
  begin(): void {
    this.attempts = [];
  }

  failed(raw: string, provider: string | undefined): FailureCause {
    const cause = classifyAttempt(raw, provider);
    this.attempts.push({ provider, cause, raw });
    return cause;
  }

  answered(provider: string | undefined): void {
    this.attempts.push({ provider, cause: null, raw: "" });
  }

  /** Whether any call this turn failed. */
  get hadFailure(): boolean {
    return this.attempts.some((attempt) => attempt.cause != null);
  }

  /**
   * Why the turn did not finish, or null when its last call answered. With
   * `poolShut`, every free source refused the account, which says more than
   * any one source's busy or quota line.
   */
  failure(poolShut = false): TurnFailure | null {
    const last = this.attempts.at(-1);
    if (last == null || last.cause == null) return null;
    const failed = this.attempts.filter((attempt) => attempt.cause != null);
    const seen = new Set(failed.map((attempt) => attempt.cause));
    if (poolShut) seen.add("free_pool_spent");
    const cause =
      CAUSE_PRIORITY.find((candidate) => seen.has(candidate)) ?? "unknown";
    const shown = failed.findLast((attempt) => attempt.cause === cause) ?? last;
    return { cause, provider: shown.provider, raw: shown.raw };
  }
}

/** What a failed turn needs beyond its cause to say what to do next. */
export interface FailureContext {
  /** The turn ran on the free pool rather than a model the user picked. */
  routed: boolean;
  /**
   * The hosted free sources the free lane would run on, in the order it
   * would try them; empty when there is none to keep going on.
   */
  freeLaneProviders: readonly string[];
  /** The turn ran on the free lane the user chose at the credit wall. */
  onFreeLane: boolean;
  /** Abacus's own $0 models, offered by name on a pinned Abacus model. */
  abacusFreeModels: ReadonlyArray<{ model: string; label: string }>;
  /**
   * Where the account's Abacus credits stand, for a turn whose own key
   * failed: some left (the turn can move to Abacus), used up (the plan is
   * the way on), or no Abacus account here at all.
   */
  abacus: "credits" | "out" | null;
  /** The model the user picked, for a card about it (one outside the plan). */
  model?: { model: string; label: string };
  /** The failed call got text or a tool call out before it ended. */
  streamed?: boolean;
  /** Cut-off cards this session already showed: from the second, no Continue. */
  cutoffsBefore?: number;
}

/** The error a failed turn ends with, as the desktop receives it. */
export interface FailurePayload {
  message: string;
  code: string;
  cause: FailureCause;
  detail?: string;
  actions?: NotificationAction[];
}

const PROVIDER_NAMES: Record<string, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  gemini: "Google Gemini",
  openrouter: "OpenRouter",
  deepseek: "DeepSeek",
  xai: "xAI",
  nvidia: "NVIDIA",
};

const providerName = (provider: string | undefined): string =>
  provider == null || provider.length === 0
    ? "The provider"
    : (PROVIDER_NAMES[provider] ??
      provider.charAt(0).toUpperCase() + provider.slice(1));

/**
 * The English words for a cause on the free pool. The app and the chat apps
 * show their own translation, keyed by the cause; these are for the log and
 * for a client that does not know the cause.
 */
const routedMessage = (failure: TurnFailure): string => {
  switch (failure.cause) {
    case "credits_exhausted":
      return "You're out of Abacus.AI credits.";
    case "credits_expired":
      return "Your free credits have expired.";
    case "payment_required": {
      const { summary, remedy } = paymentWords(failure.raw);
      return `${summary}. ${remedy}`;
    }
    case "phone_verification": {
      const { summary, remedy } = phoneWords(failure.raw);
      return `${summary}. ${remedy}`;
    }
    case "connection":
      return NETWORK_UNREACHABLE_MESSAGE;
    case "context_too_long":
      return "This conversation is too long for the free models. Start a new chat, or pick a model with a larger context.";
    case "key_invalid":
      return `Your ${providerName(failure.provider)} key was rejected — it's invalid or expired.`;
    case "own_key_quota":
      return `Your ${providerName(failure.provider)} key hit its quota. Switch to a different model, or check the key's plan.`;
    case "not_in_plan":
    case "model_unavailable":
      return "The free model couldn't take this request. Pick a different model.";
    case "free_pool_spent":
      return OPENLLM_POOL_SHUT_MESSAGE;
    case "rate_limited":
      return OPENLLM_POOL_BUSY_MESSAGE;
    case "empty":
      return EMPTY_REPLY_MESSAGE;
    case "unknown":
      return "The free models couldn't finish this. Try again, or switch to a different model.";
    case "stream_cut":
      return `${providerName(failure.provider)} cut the reply off partway, even after asking again.`;
  }
};

/** The phone-verification refusal in the app's words; the card shows its own. */
const phoneWords = (raw: string): { summary: string; remedy: string } => {
  const { link, credits } = phoneVerification(raw);
  return {
    summary: `Verify your phone to unlock ${credits ?? "your"} free credits`,
    remedy: `Verify it once at ${link}, then send your message again.`,
  };
};

/**
 * Abacus's billing refusal in the app's words: what happened and the way on,
 * support for a payment it could not confirm (never a second purchase), a
 * renewal for a subscription that ended. The card shows its own translation.
 */
const paymentWords = (raw: string): { summary: string; remedy: string } =>
  paymentRefusalReason(raw) === "lapsed"
    ? {
        summary: "Your Abacus.AI subscription has ended",
        remedy:
          "Renew it to keep going, or switch to a model with its own key.",
      }
    : {
        summary: "We couldn't confirm your last payment",
        remedy:
          "If your subscription is active, contact support@abacus.ai. Please don't purchase again.",
      };

/** The English line for the model-unavailable card; the app shows its own. */
const unavailableMessage = (action: NotificationAction): string => {
  const model = action.label ?? action.model ?? "This model";
  switch (action.cause) {
    case "plan":
      return `${model} isn't included in your plan. Your message is kept.`;
    case "down":
      return `${model} isn't available right now: its provider keeps failing. Your message is kept.`;
    default:
      return `${model} isn't available anymore. Your message is kept.`;
  }
};

/** The one line that says "busy": every failed call was a real rate limit. */
export const OPENLLM_POOL_BUSY_MESSAGE =
  "All free models are busy right now. Try again in a few minutes, or switch to a different model.";

export const EMPTY_REPLY_MESSAGE =
  "The model returned an empty reply. Try again, or switch to a different model.";

const isCredits = (cause: FailureCause): boolean =>
  cause === "credits_exhausted" || cause === "credits_expired";

/** Why the model the user picked cannot serve the turn, as its card says it. */
const UNAVAILABLE_KIND: Partial<Record<FailureCause, string>> = {
  model_unavailable: "retired",
  rate_limited: "down",
  not_in_plan: "plan",
};

/**
 * The one card for a model the user picked that cannot serve the turn (gone,
 * outside the plan, or still failing after the retries): it names the model
 * and why. With Abacus credits left the way on is RouteLLM - Open, chosen by
 * the user, never switched to; with them used up it is the plan. The user's
 * own key keeps its own card; on the pool the router picked no model.
 */
const modelUnavailableActions = (
  failure: TurnFailure,
  context: FailureContext
): NotificationAction[] | null => {
  const kind = UNAVAILABLE_KIND[failure.cause];
  if (
    kind == null ||
    context.routed ||
    context.model == null ||
    context.abacus == null ||
    failure.provider !== "abacus"
  )
    return null;
  return [
    {
      type: "model-unavailable",
      cause: kind,
      model: context.model.model,
      label: context.model.label,
    },
    context.abacus === "credits"
      ? { type: "switch-to-abacus" }
      : { type: "upgrade-abacus", cause: "exhausted" },
  ];
};

/**
 * Google cut the reply off on a model the user picked, even after asking
 * again: the card names it and offers the ways on, chosen by the user and
 * never switched to. `cause` is where the Abacus credits stand (the card
 * leads with RouteLLM - Open while some are left, with the plan once they
 * are used up); Continue goes on the same model, and is left out from the
 * session's second cut-off. On the pool the router already moved on.
 */
const cutOffActions = (
  failure: TurnFailure,
  context: FailureContext
): NotificationAction[] => {
  if (context.routed) return [{ type: "switch-model" }];
  return [
    {
      type: "cut-off",
      ...(failure.provider != null ? { provider: failure.provider } : {}),
      ...(context.model != null
        ? { model: context.model.model, label: context.model.label }
        : {}),
      cause:
        context.abacus === "credits"
          ? "credits"
          : context.abacus === "out"
            ? "out"
            : "signed-out",
      streamed: context.streamed === true,
    },
    ...((context.cutoffsBefore ?? 0) > 0 ? [] : [{ type: "continue-same" }]),
  ];
};

/** The actions a cause offers; see NotificationAction for how each renders. */
const failureActions = (
  failure: TurnFailure,
  context: FailureContext
): NotificationAction[] => {
  const provider = failure.provider;
  const unavailable = modelUnavailableActions(failure, context);
  if (unavailable != null) return unavailable;
  switch (failure.cause) {
    case "credits_exhausted":
    case "credits_expired":
      return [
        {
          type: "upgrade-abacus",
          cause: failure.cause === "credits_expired" ? "expired" : "exhausted",
        },
        // On the pool the choice is the whole free lane; on a pinned Abacus
        // model it is Abacus's own $0 models, by name.
        ...(context.routed
          ? context.freeLaneProviders.length > 0
            ? [
                {
                  type: "continue-free",
                  providers: [...context.freeLaneProviders],
                },
              ]
            : []
          : context.abacusFreeModels.map((choice) => ({
              type: "switch-model",
              model: choice.model,
              label: choice.label,
            }))),
      ];
    case "payment_required":
      // The account must settle its billing; another model is the way on now.
      return [
        { type: "payment-required", cause: paymentRefusalReason(failure.raw) },
        { type: "switch-model" },
      ];
    case "phone_verification": {
      // The one way on is the verify page: no plan, no other model.
      const { link, credits } = phoneVerification(failure.raw);
      return [
        { type: "verify-phone", link, ...(credits != null ? { credits } : {}) },
      ];
    }
    case "connection":
      return [{ type: "retry" }];
    case "context_too_long":
      return [{ type: "new-chat" }, { type: "switch-model" }];
    case "key_invalid":
    case "own_key_quota":
      if (!ownKey(provider)) return [{ type: "switch-model" }];
      // The user's own key, picked by hand: fix it, or go on with Abacus
      // (credits left), or the plan (credits used up). Never a silent move.
      if (!context.routed && context.abacus != null)
        return [
          { type: "fix-key", provider },
          context.abacus === "credits"
            ? { type: "switch-to-abacus" }
            : { type: "upgrade-abacus", cause: "exhausted" },
        ];
      return failure.cause === "key_invalid"
        ? [{ type: "fix-key", provider }, { type: "switch-model" }]
        : [{ type: "switch-model" }, { type: "fix-key", provider }];
    case "free_pool_spent":
      return [{ type: "free-pool-out" }];
    case "rate_limited": {
      if (context.routed)
        return [
          { type: "free-pool-out", cause: "busy" },
          { type: "switch-model" },
        ];
      const own = ownKeyFailureCause(failure.raw, provider);
      return own != null && ownKey(provider)
        ? [{ type: "own-key-unavailable", provider, cause: own }]
        : [{ type: "switch-model" }];
    }
    case "not_in_plan":
    case "model_unavailable":
      return [{ type: "switch-model" }];
    case "empty":
      return [{ type: "retry" }, { type: "switch-model" }];
    case "stream_cut":
      return cutOffActions(failure, context);
    case "unknown": {
      const own = context.routed
        ? null
        : ownKeyFailureCause(failure.raw, provider);
      if (own != null && ownKey(provider))
        return [{ type: "own-key-unavailable", provider, cause: own }];
      return context.routed ||
        (isProviderFailure(failure.raw) &&
          classifyProviderFailure(failure.raw, provider).remedy.includes(
            "switch"
          ))
        ? [{ type: "switch-model" }]
        : [];
    }
  }
};

/**
 * The error a failed turn ends with: the cause, the English line, and the
 * actions the app draws for it. On a pinned model the line is the
 * provider's failure in the app's words with its status, as before; on the
 * pool the user picked no model, so the line names the cause instead.
 */
export function presentFailure(
  failure: TurnFailure,
  context: FailureContext
): FailurePayload {
  // On the free lane a failed turn comes back to the credit wall's card:
  // the way past a free model that cannot do it is the plan, not a wait.
  // A dropped connection or an outgrown chat keep their own way out.
  const wallAgain =
    context.onFreeLane &&
    failure.cause !== "connection" &&
    failure.cause !== "context_too_long" &&
    failure.cause !== "payment_required" &&
    failure.cause !== "phone_verification" &&
    !isCredits(failure.cause);
  const actions = wallAgain
    ? failureActions({ ...failure, cause: "credits_exhausted" }, context)
    : failureActions(failure, context);
  const connection = failure.cause === "connection";
  // A pinned key that was refused or ran dry says whose key, not the status.
  const ownKeyLine =
    (failure.cause === "key_invalid" || failure.cause === "own_key_quota") &&
    ownKey(failure.provider);
  const pooledLine =
    context.routed ||
    connection ||
    ownKeyLine ||
    failure.cause === "empty" ||
    failure.cause === "stream_cut" ||
    failure.cause === "payment_required" ||
    failure.cause === "phone_verification";
  const unavailable = actions.find(
    (action) => action.type === "model-unavailable"
  );
  const message =
    unavailable != null
      ? unavailableMessage(unavailable)
      : pooledLine
        ? routedMessage(failure)
        : isProviderFailure(failure.raw)
          ? terminalProviderMessage(failure.raw, undefined, failure.provider)
          : readableFailure(failure.raw, failure.provider);
  // The connection card's details say what failed; on the pool the user
  // picked no model, so no provider's sentence is shown.
  const detail = connection
    ? readableProviderError(failure.raw).trim()
    : !context.routed && isProviderFailure(failure.raw)
      ? (providerDetail(failure.raw, failure.provider).detail ?? "")
      : "";
  return {
    message,
    code: connection ? NETWORK_UNREACHABLE_CODE : "turn_failed",
    cause: failure.cause,
    ...(detail.length > 0 && detail !== message ? { detail } : {}),
    ...(actions.length > 0 ? { actions } : {}),
  };
}

/** Whether a failure is worth waiting for: a rate limit, not a fault. */
export const isBusyCause = (raw: string, provider: string | undefined) =>
  classifyAttempt(raw, provider) === "rate_limited";

/** Whether the transcript no longer fits; what compaction answers. */
export const isContextTooLong = (raw: string): boolean =>
  CONTEXT_LENGTH_PATTERN.test(raw.toLowerCase());

/**
 * A provider saying the request did not fit. These all arrive as a plain 400,
 * so the sentence is the only identifier. Matched against lowercased text by
 * both the user-facing message and the compact-and-retry decision.
 */
const CONTEXT_LENGTH_PATTERN =
  /context length|context window|maximum input token limit|input is longer than|maximum context length|too many tokens|reduce the length of the messages|prompt is too long/;

/**
 * A provider refusing the request for its size against a tier limit rather
 * than the model's window: a 413, or the sentence Groq puts on one. Retrying
 * sends the same bytes again, so it is not narrated as a retry.
 */
export const REQUEST_TOO_LARGE_PATTERN =
  /request too large|request entity too large|payload too large|reduce your message size/;

/** A model refusing tools: a 400 with the reason only in the prose. */
const TOOLS_UNSUPPORTED_PATTERN =
  /does not support tool|support tool calling|tool use is not supported|does not support function calling/;

/**
 * A provider failure in the words a user can act on: the category and nothing
 * else, since the provider's text is written for whoever holds the key. The
 * unrecognized case stays vague rather than falling back to the raw text.
 */
export function providerFailureSummary(raw: string, provider?: string): string {
  return classifyProviderFailure(raw, provider).summary;
}

/** The free pool with every source refused account-wide. */
export const OPENLLM_POOL_SHUT_MESSAGE =
  "Every free source is used up for now. Connect another free source, or pick a different model to keep going.";
export const OPENLLM_POOL_EMPTY_MESSAGE =
  "RouteLLM - Open has no model to run on yet. Pick a model, or connect Abacus.AI, Google AI Studio or OpenRouter from the model list.";

/** The provider rejected the credential, rather than the account's balance. */
export function isAuthFailure(raw: string): boolean {
  const status = failureStatus(raw);

  return (
    status === "401" ||
    status === "403" ||
    /no api key|invalid api key|unauthorized|authentication/i.test(raw)
  );
}

/**
 * Why a turn on the user's own key (any provider but Abacus and the router)
 * failed, when an Abacus plan answers it: the key's balance is spent, its rate
 * limit is hit, or its provider is down, overloaded or not answering. Read
 * only off a terminal error, after the app's own retries. Null for what no
 * plan fixes (a model without tools, a conversation or request too big, a
 * rejected key) and for Abacus-served turns, which have their own card.
 */
export type OwnKeyFailureCause = "credit" | "rate_limit" | "down" | "network";

export function ownKeyFailureCause(
  raw: string,
  provider: string | undefined
): OwnKeyFailureCause | null {
  if (provider == null || provider === "abacus" || provider === "openllm") {
    return null;
  }

  if (isOwnKeyOutOfCredit(raw, provider)) return "credit";

  const status = Number(failureStatus(raw) ?? Number.NaN);
  const text = raw.toLowerCase();

  if (
    TOOLS_UNSUPPORTED_PATTERN.test(text) ||
    CONTEXT_LENGTH_PATTERN.test(text) ||
    status === 413 ||
    REQUEST_TOO_LARGE_PATTERN.test(text) ||
    isAuthFailure(raw)
  ) {
    return null;
  }

  // Gemini's RESOURCE_EXHAUSTED and OpenRouter's free daily allowance are
  // limits on the key, whatever else their sentence says about billing.
  if (
    status === 429 ||
    /rate.?limit|too many requests|resource_exhausted|free-models-per-day|quota exceeded/.test(
      text
    )
  ) {
    return "rate_limit";
  }

  // Anthropic answers an overloaded fleet with a 529.
  if (
    (status >= 500 && status <= 504) ||
    status === 529 ||
    /overloaded/.test(text)
  ) {
    return "down";
  }

  if (
    /timed out|timeout|econnreset|econnrefused|socket hang up|fetch failed|network/.test(
      text
    )
  ) {
    return "network";
  }

  return null;
}

/** A provider error, by its shape: an HTTP status code, up front or in its body. */
export function isProviderFailure(raw: string): boolean {
  return failureStatus(raw) != null;
}

/**
 * The same failure when the turn is actually over: the whole answer the user
 * gets, so it carries the status code (what makes a support conversation
 * possible) and the one thing they can do about it.
 */
/**
 * The provider's own sentence, when the app's reading of it does not already
 * carry it. "The model provider had a problem (400)" is the message a support
 * report arrives with, and on its own there is nothing to diagnose: whether
 * the request was too long, malformed, or refused for a reason nobody has
 * seen yet is in the text the provider sent, which is otherwise discarded.
 */
export function providerDetail(
  raw: string,
  provider?: string
): { detail?: string } {
  const readable = readableProviderError(raw).trim();
  const message = terminalProviderMessage(raw, undefined, provider);

  return readable.length === 0 || message.includes(readable)
    ? {}
    : { detail: readable };
}

export function terminalProviderMessage(
  raw: string,
  context?: string,
  provider?: string
): string {
  const { summary, remedy } = classifyProviderFailure(raw, provider);
  const status = failureStatus(raw);

  return [`${summary}${status == null ? "" : ` (${status})`}.`, context, remedy]
    .filter((part) => part != null)
    .join(" ");
}

/**
 * A provider failure as a summary and a remedy. `provider` is who answered:
 * only Abacus's refusals read as the Abacus credit or billing wall; absent,
 * the answer is read as Abacus's would be, as before it was passed.
 */
export function classifyProviderFailure(
  raw: string,
  provider?: string
): {
  summary: string;
  remedy: string;
} {
  const status = Number(failureStatus(raw) ?? Number.NaN);
  const text = raw.toLowerCase();

  // Before the rate-limit branch: an out-of-credits account answers 429 too,
  // and "try again in a moment" is exactly the wrong advice for it.
  const wall = abacusRefusal(raw, provider);
  if (wall === "unverified") return phoneWords(raw);
  if (wall === "payment") return paymentWords(raw);
  if (wall === "expired") {
    return {
      summary: "Your free credits have expired",
      remedy: "Upgrade your plan to keep going.",
    };
  }
  if (wall === "exhausted") {
    return {
      summary: "You're out of credits",
      remedy:
        "Upgrade your plan to keep going, or switch to a model with its own key.",
    };
  }

  // Before the rate-limit branch too: OpenAI's empty balance answers 429
  // `insufficient_quota`, and waiting a moment never refills it.
  if (namesEmptyBalance(raw)) {
    return {
      summary: "The model provider is out of quota",
      remedy: "Add credits with the provider, or switch to a different model.",
    };
  }

  // Before the rate-limit branch too: Groq's free tier answers a request over
  // its per-minute token cap with a 413 whose sentence mentions "tokens per
  // minute", and no amount of waiting makes the same request smaller.
  if (status === 413 || REQUEST_TOO_LARGE_PATTERN.test(text)) {
    return {
      summary: "This request is too large for the model's limit",
      remedy:
        "Start a new chat, switch to a model with a higher limit, or raise the limit with the provider.",
    };
  }

  if (status === 429 || /rate.?limit|too many requests/.test(text)) {
    return {
      summary: "The model provider is rate-limited",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  // These arrive as a 400 with the reason only in the prose. Behind the rate
  // limit, since a 429 means the rate limit whatever else the sentence says.
  if (TOOLS_UNSUPPORTED_PATTERN.test(text)) {
    return {
      summary: "This model can't use tools",
      remedy: "Switch to a model that supports tool calling.",
    };
  }

  if (CONTEXT_LENGTH_PATTERN.test(text)) {
    return {
      summary: "This conversation is too long for the model",
      remedy: "Start a new chat, or switch to a model with a larger context.",
    };
  }

  if (status === 402 || /credit|quota|billing|insufficient/.test(text)) {
    return {
      summary: "The model provider is out of quota",
      remedy: "Add credits with the provider, or switch to a different model.",
    };
  }

  // Before the 403 branches: the key is fine, the plan does not include the
  // model, and "check your model access" would send the user to the keys page.
  if (isPlanRejection(raw)) {
    return {
      summary: "This model isn't included in your plan",
      remedy: "Upgrade your plan to use it, or choose another model.",
    };
  }

  // The platform's answer to a key of the wrong kind (a terminal/CodeLLM key
  // on a bot endpoint); the key itself is fine, and Settings → Models is the
  // wrong place to look.
  if (status === 403 && /not allowed for this api/i.test(text)) {
    return {
      summary: "This key isn't an AbacusAI Bot key",
      remedy:
        "Sign out in Settings → Account and sign in again to get a bot key.",
    };
  }

  if (status === 403) {
    return {
      summary: "The model provider denied access",
      remedy:
        "Check your model access in Settings → Models, or choose another model.",
    };
  }
  if (status === 401 || /api key|unauthorized/.test(text)) {
    return {
      summary: "The model provider rejected the key",
      remedy: "Check the key in Settings → Models.",
    };
  }

  if (/timed out|timeout|econnreset|network/.test(text)) {
    return {
      summary: "The model provider did not respond",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  if (status >= 500 || /overloaded|unavailable/.test(text)) {
    return {
      summary: "The model provider is temporarily unavailable",
      remedy: "Try again in a moment, or switch to a different model.",
    };
  }

  return {
    summary: "The model provider had a problem",
    remedy: "Try again, or switch to a different model.",
  };
}

/**
 * The sentence a provider error is actually trying to say, pulled out of the
 * JSON envelope that buries it: `429: {json}`, bare `{json}`, or JSON after
 * any prefix, with the sentence at `message`, `error.message` or `error`.
 * Prose with no envelope is returned as-is (capped), so errors nobody has
 * seen yet still say something; the JSON itself never comes back.
 */
export function readableProviderError(raw: string): string {
  const cap = (text: string): string =>
    text.length > 300 ? `${text.slice(0, 300)}…` : text;
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}") + 1;
  // No closing brace: cut short in transit, the rest is all there is.
  const json =
    start === -1 ? "" : raw.slice(start, end > start ? end : undefined);

  if (!/"\w+"\s*:/.test(json)) return cap(raw);

  const head = raw.slice(0, start).replace(/[\s:]+$/, "");
  const sentence = envelopeSentence(json);

  return cap(
    [head.length > 0 ? `${head}:` : "", sentence]
      .filter((part) => part.length > 0)
      .join(" ")
      .replace(/:$/, "")
  );
}

/** The human words in a JSON error envelope, or "" when it carries none. */
function envelopeSentence(json: string, nested = false): string {
  let body: unknown;
  try {
    body = JSON.parse(json);
  } catch {
    // Cut short in transit: the message is still there to read.
    const message = json.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/)?.[1];
    try {
      return message == null ? "" : (JSON.parse(`"${message}"`) as string);
    } catch {
      return message ?? "";
    }
  }

  const read = (value: unknown): string => {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) return read(value[0]);
    if (value == null || typeof value !== "object") return "";
    const record = value as {
      error?: unknown;
      message?: unknown;
      metadata?: { raw?: unknown; remedy_hint?: unknown };
    };
    const inner = read(record.error);
    if (inner.length > 0) return inner;
    const message = typeof record.message === "string" ? record.message : "";
    let detail =
      typeof record.metadata?.raw === "string"
        ? record.metadata.raw
        : typeof record.metadata?.remedy_hint === "string"
          ? record.metadata.remedy_hint
          : "";
    // OpenRouter relays the upstream's own envelope as a string.
    const relayed = detail.slice(
      detail.indexOf("{"),
      detail.lastIndexOf("}") + 1
    );
    if (!nested && /"\w+"\s*:/.test(relayed)) {
      detail = envelopeSentence(relayed, true);
    }
    return [message, detail].filter((part) => part.length > 0).join(" ");
  };

  return read(body);
}

/** A thrown failure that is not a provider's, in words rather than JSON. */
export function readableFailure(raw: string, provider?: string): string {
  const readable = readableProviderError(raw).trim();

  return readable.length > 0
    ? readable
    : terminalProviderMessage(raw, undefined, provider);
}
