import { providerDisplayName } from "@abacus-ai/contract/settings";
import type { TFunction } from "i18next";

/** A failed turn's error, as the agent sends it (turn-outcome.ts). */
export interface TurnFailureView {
  message?: string;
  code?: string;
  cause?: string;
  /** The provider's own sentence: read here to classify, never shown. */
  detail?: string;
  actions?: ReadonlyArray<{
    type: string;
    provider?: string;
    bytesFree?: number;
  }>;
}

/** Causes with a line of their own, as the agent named them. */
const CAUSE_KEYS: Readonly<Record<string, string>> = {
  context_too_long: "outcome.cause.context_too_long",
  key_invalid: "outcome.cause.key_invalid",
  own_key_quota: "outcome.cause.own_key_quota",
  model_unavailable: "outcome.cause.model_unavailable",
  // A model the plan does not include: the way on is another model.
  not_in_plan: "outcome.cause.model_unavailable",
  content_refused: "outcome.cause.content_refused",
  free_pool_spent: "outcome.cause.free_pool_spent",
  rate_limited: "outcome.cause.rate_limited",
  empty: "outcome.cause.empty",
  stalled: "outcome.cause.stalled",
  stream_cut: "outcome.cause.stream_cut",
  unknown: "outcome.cause.unknown",
};

/**
 * What a provider's own refusal says, when the user can fix it: a setting
 * the model's config sends, the key, or the context. Read from the detail,
 * never shown from it.
 */
const DETAIL_CAUSES: ReadonlyArray<[RegExp, string]> = [
  [
    /context (?:length|window)|maximum context|too many tokens|prompt is too long/i,
    "context_too_long",
  ],
  [
    /invalid (?:x-)?api[ _-]?key|incorrect api key|api key not valid|unauthori[sz]ed|authentication/i,
    "key_invalid",
  ],
  [
    /insufficient[_ ]quota|exceeded your current quota|credit balance is too low|billing/i,
    "own_key_quota",
  ],
  [
    /unsupported (?:parameter|value)|unknown (?:parameter|field)|unrecognized (?:request )?argument|extra inputs are not permitted|is not supported (?:with|by|for) this model|invalid (?:value|parameter)|does not support/i,
    "config_rejected",
  ],
];

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * A failed turn's line in the app's words, for the card and for the
 * screen reader alike: the crash or the connection, the cause's own line,
 * else what the provider's refusal says the user can fix, else the generic
 * one. The agent's message and the provider's detail are for the log.
 */
export const failureLine = (t: TFunction, error: TurnFailureView): string => {
  if (error.code === "agent_exit" || error.code === "agent_crashed")
    return t("chat.error.crashed");
  if (error.code === "network_unreachable")
    return t("outcome.connection.title");
  const actions = error.actions ?? [];
  if (error.cause === "disk_full") {
    const free = actions.find((action) => action.type === "retry")?.bytesFree;
    return free != null
      ? t("outcome.cause.disk_full", { free: formatBytes(free) })
      : t("outcome.cause.disk_fullUnmeasured");
  }
  const provider = providerDisplayName(
    actions.find((action) => action.provider != null)?.provider ?? ""
  );
  const vague =
    error.cause == null ||
    error.cause === "unknown" ||
    error.cause === "model_unavailable";
  const fromDetail =
    vague && error.detail != null
      ? DETAIL_CAUSES.find(([pattern]) => pattern.test(error.detail!))?.[1]
      : undefined;
  if (fromDetail === "config_rejected")
    return t("outcome.cause.config_rejected");
  const cause = fromDetail ?? error.cause;
  // A key's line names its provider: without one it is the generic line.
  const key =
    (cause === "key_invalid" || cause === "own_key_quota") && provider === ""
      ? undefined
      : cause != null
        ? CAUSE_KEYS[cause]
        : undefined;
  return t(key ?? "outcome.cause.unknown", { provider });
};
