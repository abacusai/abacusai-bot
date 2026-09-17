/**
 * Debug-sync core: decides whether to send a transcript and does the send.
 * No electron, fs, or path aliases, so it runs under plain `node` for tests.
 * The server keeps an append-only log with one row per segment, so each turn
 * ships only `segments.slice(syncedCount)` tagged with its index.
 */

import type { ClientEnvironment } from "../diagnostics/client-environment";
import type { StoredTranscript } from "../session/transcript-service";

export interface SyncClientMeta {
  clientVersion: string;
  deviceId: string;
  environment: ClientEnvironment;
}

export interface SyncEvent {
  event_sequence_number: number;
  segment: unknown;
}

/** snake_case, matching the /v1 surface. */
export interface SyncPayload {
  session_id: string;
  device_id: string;
  /** The /v1 surface's own key; `environment` carries the rest of the machine. */
  platform: string;
  client_version: string;
  environment: ClientEnvironment;
  events: SyncEvent[];
}

export interface SyncDeps {
  /** The Abacus (`abacusaibot`) API key, or undefined when signed out. */
  readKey: () => string | undefined;
  syncUrl: () => string;
  readTranscript: (sessionId: string) => StoredTranscript | null;
  /** The marker: how many of the session's segments are already synced. */
  readSyncedCount: (sessionId: string) => number;
  clientMeta: () => SyncClientMeta;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (message: string, extra?: unknown) => void;
}

export type SyncOutcome =
  | { status: "ok"; sessionId: string; events: number; syncedThrough: number }
  | { status: "skipped"; sessionId: string; reason: "no-key" | "empty" }
  | { status: "error"; sessionId: string; reason: string; retryable: boolean };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Coalescing gate: N enqueues for the same turn become one upload, and none
 * once caught up.
 */
export function shouldSync(
  transcript: StoredTranscript | null,
  syncedCount: number | undefined
): boolean {
  if (transcript == null) return false;
  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0)
    return false;
  return transcript.segments.length > (syncedCount ?? 0);
}

export function buildSyncPayload(
  transcript: StoredTranscript,
  meta: SyncClientMeta,
  syncedCount: number
): SyncPayload {
  const events: SyncEvent[] = [];
  for (let i = Math.max(0, syncedCount); i < transcript.segments.length; i++) {
    events.push({ event_sequence_number: i, segment: transcript.segments[i] });
  }
  return {
    session_id: transcript.sessionId,
    device_id: meta.deviceId,
    platform: meta.environment.platform,
    client_version: meta.clientVersion,
    environment: meta.environment,
    events,
  };
}

/**
 * One upload attempt. Returns an outcome rather than throwing; `retryable`
 * separates transient failures (network, 5xx, 429) from permanent 4xx ones.
 */
export async function syncTranscriptOnce(
  deps: SyncDeps,
  sessionId: string
): Promise<SyncOutcome> {
  const key = deps.readKey();
  if (key == null || key.trim().length === 0)
    return { status: "skipped", sessionId, reason: "no-key" };

  const transcript = deps.readTranscript(sessionId);
  if (
    transcript == null ||
    !Array.isArray(transcript.segments) ||
    transcript.segments.length === 0
  )
    return { status: "skipped", sessionId, reason: "empty" };

  const syncedCount = deps.readSyncedCount(sessionId);
  const total = transcript.segments.length;
  if (total <= syncedCount)
    return { status: "skipped", sessionId, reason: "empty" };

  const payload = buildSyncPayload(transcript, deps.clientMeta(), syncedCount);
  const body = JSON.stringify(payload);
  const doFetch = deps.fetchImpl ?? fetch;
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    deps.timeoutMs ?? DEFAULT_TIMEOUT_MS
  );

  try {
    const resp = await doFetch(deps.syncUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${key.trim()}`,
        "Content-Type": "application/json",
      },
      body,
      signal: controller.signal,
    });

    if (resp.ok) {
      deps.log?.(
        `[debug-sync] synced ${sessionId}: ${payload.events.length} event(s) through ${total}`
      );
      return {
        status: "ok",
        sessionId,
        events: payload.events.length,
        syncedThrough: total,
      };
    }

    // 4xx (except 429) is permanent: bad key or non-eligible org.
    const retryable = resp.status >= 500 || resp.status === 429;
    return {
      status: "error",
      sessionId,
      reason: `http ${resp.status}`,
      retryable,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "error", sessionId, reason, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  /** Injected so tests do not wait. */
  sleep?: (ms: number) => Promise<void>;
}

/** Retries only `retryable` failures with exponential backoff. */
export async function syncTranscriptWithRetry(
  deps: SyncDeps,
  sessionId: string,
  options: RetryOptions = {}
): Promise<SyncOutcome> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseBackoffMs = options.baseBackoffMs ?? 2_000;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: SyncOutcome = {
    status: "error",
    sessionId,
    reason: "not attempted",
    retryable: false,
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await syncTranscriptOnce(deps, sessionId);
    if (last.status !== "error" || !last.retryable) return last;
    await sleep(baseBackoffMs * 2 ** attempt);
  }
  return last;
}
