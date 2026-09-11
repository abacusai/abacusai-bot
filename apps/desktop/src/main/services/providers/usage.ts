import * as path from "path";

import {
  fetchOpenRouterKeyStatus,
  UsageScanner,
  type OpenRouterKeyStatus,
} from "@abacus-ai/agent/usage";

import type { UsageSnapshot } from "#shared/contracts";

import { abacusBotHome } from "../../paths";
import { readSettings } from "../config/settings";

/**
 * The Usage panel's data: spend per model and per day from the agent's session
 * logs, plus OpenRouter's account-wide key status. The scanner is shared with
 * the CLI's `usage` command so both front ends agree.
 */

const sessionsDir = (): string =>
  path.join(abacusBotHome(), "agent", "sessions");

let scanner: UsageScanner | null = null;

/** OpenRouter status, cached briefly: the panel refetches on every focus. */
let keyStatus: { at: number; value: OpenRouterKeyStatus | null } | null = null;

/** In-flight request, so two panels opening at once share one fetch. */
let keyStatusInFlight: Promise<OpenRouterKeyStatus | null> | null = null;

const KEY_STATUS_TTL_MS = 60_000;

const resolveOpenRouterKey = (): string | undefined => {
  const fromEnv = process.env.OPENROUTER_API_KEY;

  if (fromEnv != null && fromEnv.length > 0) return fromEnv;

  return readSettings().apiKeys?.OPENROUTER_API_KEY;
};

const openRouterStatus = async (
  key: string
): Promise<OpenRouterKeyStatus | null> => {
  if (keyStatus != null && Date.now() - keyStatus.at <= KEY_STATUS_TTL_MS) {
    return keyStatus.value;
  }

  keyStatusInFlight ??= fetchOpenRouterKeyStatus(key)
    .then((value) => {
      // Stamped on arrival, not on departure: a slow call would otherwise
      // spend most of its TTL already expired.
      keyStatus = { at: Date.now(), value };

      return value;
    })
    .finally(() => {
      keyStatusInFlight = null;
    });

  return keyStatusInFlight;
};

export const getUsageSnapshot = async (): Promise<UsageSnapshot> => {
  scanner ??= new UsageScanner(sessionsDir());

  const summary = await scanner.summary(30);
  const key = resolveOpenRouterKey();

  if (key == null || key.length === 0) {
    keyStatus = null;

    return { ...summary, openrouter: null };
  }

  return { ...summary, openrouter: await openRouterStatus(key) };
};

/**
 * The same numbers without the network call, for the log dump: it must not
 * hang on OpenRouter while the user is saving a file about a broken app.
 */
export const getLocalUsageSnapshot = async (): Promise<UsageSnapshot> => {
  scanner ??= new UsageScanner(sessionsDir());

  return { ...(await scanner.summary(30)), openrouter: null };
};

/** Test seam: forget the scanner and key cache, so a test can re-point HOME. */
export const resetUsageService = (): void => {
  scanner = null;
  keyStatus = null;
  keyStatusInFlight = null;
};
