import { providerDisplayName } from "@abacus-ai/contract/settings";
import type { TFunction } from "i18next";

/** A failed turn's error, as the agent sends it (turn-outcome.ts). */
export interface TurnFailureView {
  message?: string;
  code?: string;
  cause?: string;
  /** The provider's own sentence: for the log, never read here. */
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

/** Keys that are the platform's, not the user's: never "your key". */
const PLATFORM_PROVIDERS: ReadonlySet<string> = new Set([
  "abacus",
  "openllm",
  "local",
]);

const formatBytes = (bytes: number): string =>
  bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(1)} GB`
    : `${Math.round(bytes / 1024 ** 2)} MB`;

/**
 * A failed turn's line in the app's words: the crash or the connection,
 * else the line of the cause the agent decided, else the generic one. The
 * agent's message and the provider's detail are for the log.
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
  // Only the agent's own reading of the failure (classifyAttempt) picks
  // the line: the provider's detail is never read here.
  const cause = error.cause;
  // A key's line is for the user's own key: its provider names it.
  const ownKey = actions.find(
    (action) =>
      action.provider != null && !PLATFORM_PROVIDERS.has(action.provider)
  )?.provider;
  const provider = providerDisplayName(ownKey ?? "");
  const key =
    (cause === "key_invalid" || cause === "own_key_quota") && ownKey == null
      ? undefined
      : cause != null
        ? CAUSE_KEYS[cause]
        : undefined;
  return t(key ?? "outcome.cause.unknown", { provider });
};
