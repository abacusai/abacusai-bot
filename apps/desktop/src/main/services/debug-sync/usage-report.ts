/**
 * Reports each finished turn to the platform's usage counts
 * (`/v1/abacusaibot_usage`), so the daily report knows how many people use
 * the web app and the desktop app and how much.
 *
 * One POST per turn, carrying only a random turn id, the surface (web or
 * desktop) and the kind of turn: the user's own chat, a bot's session, or a
 * routine run. No content. The phone lane's turns are counted by the server,
 * so they are skipped here. Fire and forget: never awaited, never retried,
 * and nothing here can throw into the caller.
 */
import { randomUUID } from "crypto";

import type { DesktopEvent } from "@abacus-ai/contract/agent-types";
import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";

import { readSettings } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";

const TIMEOUT_MS = 10_000;

export type UsageSurface = "web" | "desktop";
export type UsageTurnKind = "user" | "channel" | "routine";

export interface UsageSessionFacts {
  /** The host lane keeping this session (the phone loop), if any. */
  laneOf(sessionId: string): string | null;
  isRoutineSession(sessionId: string): boolean;
  /** A bot's session: its loop or a conversation with someone it serves. */
  isBotSession(sessionId: string): boolean;
}

/** The kind of turn a session runs, or null for one counted elsewhere. */
export function usageTurnKind(
  facts: UsageSessionFacts,
  sessionId: string
): UsageTurnKind | null {
  if (facts.laneOf(sessionId) != null) return null;
  if (facts.isRoutineSession(sessionId)) return "routine";
  if (facts.isBotSession(sessionId)) return "channel";
  return "user";
}

/**
 * A listener for ServiceHost.onAgentEvent: one report per `turn_complete`.
 * Swallows every error, so it can never disturb the listeners after it.
 */
export function createUsageReporter(
  surface: UsageSurface,
  facts: UsageSessionFacts,
  fetchImpl: typeof fetch = fetch
): (sessionId: string, payload: DesktopEvent) => void {
  return (sessionId, payload) => {
    try {
      if (payload.type !== "event" || payload.event.type !== "turn_complete")
        return;
      const kind = usageTurnKind(facts, sessionId);
      if (kind == null) return;
      const key = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim();
      if (!key) return;
      void fetchImpl(`${abacusRoutellmV1()}/abacusaibot_usage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ turn_id: randomUUID(), surface, kind }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {
        // Offline or refused: a lost count is not worth a retry queue.
      });
    } catch {
      // Never into the caller: counting must not touch the turn.
    }
  };
}
