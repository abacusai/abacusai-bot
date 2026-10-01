/**
 * What a pool model's failure means for how long it, or its whole provider,
 * sits out. pi hands over the provider's error as text, status first, so the
 * text is what is read: the status class, and any wait the provider names
 * ("try again in 7m12s", "retryDelay": "30s"), which beats any guess.
 */
import {
  accountWideFailure,
  OPENLLM_ACCOUNT_COOLDOWN_MS,
  type FailureScope,
} from "./openllm.js";

const SECOND_MS = 1000;
const HOUR_MS = 60 * 60 * SECOND_MS;
const DAY_MS = 24 * HOUR_MS;

/** A named wait is trusted within these bounds. */
const MIN_HINT_MS = 5 * SECOND_MS;
const MAX_HINT_MS = DAY_MS;

export interface FailureVerdict {
  /** How long the model sits out; absent leaves the usual escalating wait. */
  cooldownMs?: number;
  /** The provider or tier refused, not the model: every sibling sits out. */
  scope?: FailureScope;
  scopeMs?: number;
}

const UNIT_MS: Record<string, number> = {
  h: HOUR_MS,
  m: 60 * SECOND_MS,
  s: SECOND_MS,
  ms: 1,
};

/** "7m12.5s", "1h2m", "30s", "450ms" as milliseconds, or null. */
const parseDuration = (text: string): number | null => {
  let total = 0;
  let matched = false;
  for (const [, amount, unit] of text.matchAll(/(\d+(?:\.\d+)?)(ms|h|m|s)/g)) {
    total += Number(amount) * (UNIT_MS[unit ?? "s"] ?? SECOND_MS);
    matched = true;
  }
  return matched ? total : null;
};

/** The wait the provider named, in milliseconds, or null when it named none. */
export const retryHintMs = (failure: string): number | null => {
  const named =
    // Groq, OpenAI: "Please try again in 7m12.5s."
    failure.match(/try again in\s+((?:\d+(?:\.\d+)?(?:ms|h|m|s))+)/i)?.[1] ??
    // Gemini: "retryDelay": "30s", or "Please retry in 23.4s."
    failure.match(
      /retry(?:Delay"?\s*:\s*"|\s+in\s+)(\d+(?:\.\d+)?(?:ms|s))/i
    )?.[1];
  if (named != null) {
    const ms = parseDuration(named);
    if (ms != null) return clampHint(ms);
  }
  // "retry after 30 seconds", "Retry-After: 30"
  const seconds = failure.match(/retry[- ]after:?\s+(\d+(?:\.\d+)?)/i)?.[1];
  return seconds != null ? clampHint(Number(seconds) * SECOND_MS) : null;
};

const clampHint = (ms: number): number =>
  Math.min(MAX_HINT_MS, Math.max(MIN_HINT_MS, ms));

const untilNextUtcDay = (now: number): number => DAY_MS - (now % DAY_MS);

/** The HTTP status, which leads pi's text or sits early in a provider's own. */
const status = (failure: string): number | null => {
  const code = failure.slice(0, 120).match(/\b([45]\d\d)\b/)?.[1] ?? null;
  return code == null ? null : Number(code);
};

const KEY_REFUSED =
  /invalid[_ ]api[_ ]key|incorrect api key|api key (?:not valid|is invalid)|unauthori[sz]ed|authentication|invalid (?:token|credentials)/i;
const MODEL_GONE =
  /model[_ ]not[_ ]found|model .*(?:does not exist|not found|decommissioned|deprecated)|no endpoints found|is not a valid model/i;
/** The pool is for agent turns: a model that cannot take tools is no use. */
const NO_TOOLS =
  /(?:does not|doesn't) support (?:tools|tool use|tool calling|function calling)|tools? (?:are|is) not supported|tool[_ ]use[_ ]not[_ ]supported/i;
const TOO_LARGE =
  /request too large|payload too large|request entity too large|context length|maximum context|too many tokens|prompt is too long/i;
const DAILY =
  /per day|daily|\brpd\b|\btpd\b|requests? per day|tokens? per day/i;

/** What `failure` from a model under `provider` means; see FailureVerdict. */
export function classifyFailure(
  failure: string,
  provider: string | undefined,
  now: number = Date.now()
): FailureVerdict {
  const code = status(failure);
  const hint = retryHintMs(failure);

  // A refused key fails the same on every model it opens, until it is
  // replaced; a new key clears every cooldown (clearCooldowns).
  if (
    provider != null &&
    (code === 401 || (code === 403 && KEY_REFUSED.test(failure)))
  ) {
    return { scope: { provider }, scopeMs: DAY_MS };
  }

  const scope = accountWideFailure(failure, provider);
  if (scope != null) {
    return { scope, scopeMs: hint ?? OPENLLM_ACCOUNT_COOLDOWN_MS };
  }

  // Mistral's free tier allows one request a second across the account.
  if (provider === "mistral" && code === 429) {
    return { scope: { provider }, scopeMs: hint ?? 60 * SECOND_MS };
  }

  if (
    code === 404 ||
    code === 410 ||
    MODEL_GONE.test(failure) ||
    NO_TOOLS.test(failure)
  ) {
    return { cooldownMs: DAY_MS };
  }
  // Not offered on this key's tier: the same answer all day.
  if (code === 403) return { cooldownMs: DAY_MS };
  // This transcript does not fit the model's window or per-minute size cap.
  if (code === 413 || TOO_LARGE.test(failure)) return { cooldownMs: HOUR_MS };

  if (code === 429 && DAILY.test(failure)) {
    return { cooldownMs: hint ?? untilNextUtcDay(now) };
  }
  return hint != null ? { cooldownMs: hint } : {};
}

/**
 * Markers free models use when they write a tool call as text instead of
 * making it: the turn ends looking finished with the call never run.
 */
const LEAKED_TOOL_CALL =
  /<\/?tool_call>|<\|tool_calls?(?:_section)?_begin\|>|<\|tool_call\|>|\[TOOL_CALLS\]|<function=[\w.-]+>|<invoke name=|<\|python_tag\|>/;

const isAssistant = (message: unknown): boolean =>
  (message as { role?: unknown } | undefined)?.role === "assistant";

/**
 * The failure a pool turn ended on when its last reply wrote a tool call as
 * text, or null. Another model makes the call properly.
 */
export function endedOnLeakedToolCall(
  messages: readonly unknown[]
): string | null {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index];
    if (!isAssistant(message)) continue;
    const content = (message as { content?: unknown }).content;
    if (!Array.isArray(content)) return null;
    const blocks = content as Array<{ type?: unknown; text?: unknown }>;
    if (blocks.some((block) => block.type === "toolCall")) return null;
    const text = blocks
      .filter(
        (block) => block.type === "text" && typeof block.text === "string"
      )
      .map((block) => block.text as string)
      .join("\n");
    return LEAKED_TOOL_CALL.test(text)
      ? "model wrote its tool call as text"
      : null;
  }
  return null;
}
