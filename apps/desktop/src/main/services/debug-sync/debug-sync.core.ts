/**
 * Debug-sync core: decides whether to send a transcript and does the send.
 * No electron, fs, or path aliases, so it runs under plain `node` for tests.
 * The server keeps an append-only log, so each segment is sent once, under the
 * next free sequence: the local transcript is rewritten in place, and a
 * segment's position in it is not where the server holds it.
 */

import type { ClientEnvironment } from "../diagnostics/client-environment";
import { scrubValue } from "../diagnostics/scrub";
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
  readSyncState: (sessionId: string) => SyncState;
  clientMeta: () => SyncClientMeta;
  /** Injected for tests; defaults to global fetch. */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (message: string, extra?: unknown) => void;
}

/** What the server holds for a session. */
export interface SyncState {
  /** The sequence the next uploaded segment gets. */
  next: number;
  /** Segment key to the sequence it was uploaded under. */
  sequences: Record<string, number>;
}

export const emptySyncState = (): SyncState => ({ next: 0, sequences: {} });

/**
 * A segment's identity in the upload log. Both frames of a sub-agent bracket
 * share an id, so the frame's status is part of it; an id-less segment falls
 * back to its position.
 */
export function syncKey(segment: unknown, index: number): string {
  const record =
    typeof segment === "object" && segment != null
      ? (segment as Record<string, unknown>)
      : {};
  const id = record.id;
  if (typeof id !== "string" || id.length === 0) return `@${index}`;
  return record.type === "subtask"
    ? `subtask:${String(record.status)}:${id}`
    : id;
}

/**
 * State for a marker written as a plain count: the first `count` segments are
 * taken as uploaded where they now sit.
 */
export function syncStateFromCount(
  transcript: StoredTranscript | null,
  count: number
): SyncState {
  const sequences: Record<string, number> = {};
  const segments = Array.isArray(transcript?.segments)
    ? transcript.segments
    : [];
  segments.slice(0, count).forEach((segment, index) => {
    const key = syncKey(segment, index);
    if (!(key in sequences)) sequences[key] = index;
  });
  return { next: count, sequences };
}

/** The transcript's segments the server does not hold yet, in order. */
export function unsyncedSegments(
  transcript: StoredTranscript,
  state: SyncState
): Array<{ key: string; segment: unknown }> {
  const pending: Array<{ key: string; segment: unknown }> = [];
  const seen = new Set<string>();
  transcript.segments.forEach((segment, index) => {
    const key = syncKey(segment, index);
    if (key in state.sequences || seen.has(key)) return;
    seen.add(key);
    pending.push({ key, segment });
  });
  return pending;
}

export type SyncOutcome =
  | { status: "ok"; sessionId: string; events: number; state: SyncState }
  | { status: "skipped"; sessionId: string; reason: "no-key" | "empty" }
  | { status: "error"; sessionId: string; reason: string; retryable: boolean };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Coalescing gate: N enqueues for the same turn become one upload, and none
 * once caught up.
 */
export function shouldSync(
  transcript: StoredTranscript | null,
  state: SyncState
): boolean {
  if (transcript == null) return false;
  if (!Array.isArray(transcript.segments) || transcript.segments.length === 0)
    return false;
  return unsyncedSegments(transcript, state).length > 0;
}

/** The upload, and the state the server is in once it lands. */
export function buildSyncPayload(
  transcript: StoredTranscript,
  meta: SyncClientMeta,
  state: SyncState
): { payload: SyncPayload; after: SyncState } {
  const sequences = { ...state.sequences };
  let next = Math.max(0, state.next);
  const events: SyncEvent[] = [];
  for (const { key, segment } of unsyncedSegments(transcript, state)) {
    sequences[key] = next;
    // Keys a tool printed and the user's name never leave the machine.
    events.push({ event_sequence_number: next, segment: scrubValue(segment) });
    next += 1;
  }
  return {
    payload: {
      session_id: transcript.sessionId,
      device_id: meta.deviceId,
      platform: meta.environment.platform,
      client_version: meta.clientVersion,
      environment: meta.environment,
      events,
    },
    after: { next, sequences },
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

  const { payload, after } = buildSyncPayload(
    transcript,
    deps.clientMeta(),
    deps.readSyncState(sessionId)
  );
  if (payload.events.length === 0)
    return { status: "skipped", sessionId, reason: "empty" };
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
        `[debug-sync] synced ${sessionId}: ${payload.events.length} event(s) through ${after.next}`
      );
      return {
        status: "ok",
        sessionId,
        events: payload.events.length,
        state: after,
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
