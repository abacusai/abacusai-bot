/**
 * Reports each finished turn to the platform's usage counts
 * (`/v1/abacusaibot_usage`), so the daily report knows how many people use
 * the web app and the desktop app and how much.
 *
 * One POST per turn, carrying only a random turn id, the surface (web or
 * desktop), the device's offset from UTC (the platform counts the daily
 * streak's days in it) and the kind of turn, decided by what opened the turn rather than
 * by the session it ran in:
 *
 * - `routine`: a routine's run, in its own session or fired into a chat;
 * - `channel`: a message from a chat app (the user's own WhatsApp, Telegram
 *   or Discord, or someone writing to their bot) that the turn answered;
 * - `user`: the user's own words typed in the app, in any chat, their bots'
 *   included.
 *
 * Not reported: a turn the app opened with no words of the user's (a bot's
 * first run, a note, a task one bot passed to another), a turn that never
 * started or was cut off by the app closing, and the phone lane's turns,
 * which the server counts itself. No content. Fire and forget: never
 * awaited, never retried, and nothing here can throw into the caller.
 */
import { randomUUID } from "crypto";

import { PROVIDER_ENV_VARS } from "@abacus-ai/contract/settings";
import { utcOffsetMinutes } from "@abacus-ai/contract/streak";

import { readSettings } from "../config/settings";
import { abacusRoutellmV1 } from "../providers/abacus-host";
import type { TurnRecord } from "../session/turn-ledger";

const TIMEOUT_MS = 10_000;

export type UsageSurface = "web" | "desktop";
export type UsageTurnKind = "user" | "channel" | "routine";

export interface UsageSessionFacts {
  /** The host lane keeping this session (the phone loop), if any. */
  laneOf(sessionId: string): string | null;
  isRoutineSession(sessionId: string): boolean;
}

/** The kind of a closed turn, or null for one not reported here. */
export function usageTurnKind(
  facts: UsageSessionFacts,
  record: Pick<TurnRecord, "sessionId" | "kind" | "channel" | "opener">
): UsageTurnKind | null {
  // Nothing ran, or the close is replayed from the last run's journal.
  if (record.kind === "not_started" || record.kind === "app_closed")
    return null;
  if (facts.laneOf(record.sessionId) != null) return null;
  if (record.opener === "routine" || facts.isRoutineSession(record.sessionId))
    return "routine";
  if (record.opener !== "user") return null;
  return record.channel != null ? "channel" : "user";
}

/**
 * A listener for TurnLedger.onClose: one report per closed turn. Swallows
 * every error, so it can never disturb the listeners after it.
 */
export function createUsageReporter(
  surface: UsageSurface,
  facts: UsageSessionFacts,
  fetchImpl: typeof fetch = fetch
): (record: TurnRecord) => void {
  return (record) => {
    try {
      const kind = usageTurnKind(facts, record);
      if (kind == null) return;
      const key = readSettings().apiKeys?.[PROVIDER_ENV_VARS.abacus]?.trim();
      if (!key) return;
      void fetchImpl(`${abacusRoutellmV1()}/abacusaibot_usage`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${key}`,
          "Content-Type": "application/json",
        },
        // The device's offset: the platform counts the daily streak in the user's own days.
        body: JSON.stringify({
          turn_id: randomUUID(),
          surface,
          kind,
          utc_offset_minutes: utcOffsetMinutes(),
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      }).catch(() => {
        // Offline or refused: a lost count is not worth a retry queue.
      });
    } catch {
      // Never into the caller: counting must not touch the turn.
    }
  };
}
