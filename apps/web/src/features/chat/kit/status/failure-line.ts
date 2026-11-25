import { providerDisplayName } from "@abacus-ai/contract/settings";
import type { TFunction } from "i18next";

/** Why the turn did not finish, as the agent named it (turn-outcome.ts). */
const OUTCOME_CAUSES = new Set([
  "context_too_long",
  "key_invalid",
  "own_key_quota",
  "model_unavailable",
  "content_refused",
  "free_pool_spent",
  "rate_limited",
  "empty",
  "unknown",
]);

/**
 * A failed turn's line in the app's words: its cause's copy, else the
 * generic one. The agent's own message (a provider's words, a status, an
 * exception) is never the line; it is for the log.
 */
export const failureLine = (
  t: TFunction,
  cause: string | undefined,
  provider = ""
): string =>
  t(
    `outcome.cause.${cause != null && OUTCOME_CAUSES.has(cause) ? cause : "unknown"}`,
    { provider: providerDisplayName(provider) }
  );
