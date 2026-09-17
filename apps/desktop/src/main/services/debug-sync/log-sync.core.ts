/**
 * Log-sync core: uploads byte-offset deltas of the per-day log files under
 * `~/.abacusai-bot/logs/`. The server appends a delta only when its offset
 * matches what it holds, so a retry re-aligns instead of duplicating. No
 * electron or fs here; the wiring lives in `log-sync-service.ts`.
 */

import type { ClientEnvironment } from "../diagnostics/client-environment";

/** One (stream, day) file's new bytes, tagged with the offset they start at. */
export interface LogChunk {
  stream: string;
  day: string;
  offset: number;
  content: string;
}

/** Per-file outcome: the server's authoritative stored size and bytes written. */
export interface LogFileResult {
  stream: string;
  day: string;
  stored: number;
  wrote: number;
}

export interface LogSyncDeps {
  /** The Abacus (`abacusaibot`) API key, or undefined when signed out. */
  readKey: () => string | undefined;
  syncUrl: () => string;
  deviceId: () => string;
  clientVersion: () => string;
  environment: () => ClientEnvironment;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export type LogBatchOutcome =
  | { status: "ok"; results: LogFileResult[] }
  | { status: "skipped"; reason: "no-key" | "empty" }
  | { status: "error"; reason: string; retryable: boolean };

const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Everything up to the last complete line, so a half-written final line waits
 * for next time; null when there is none. Slicing on 0x0a never splits a
 * UTF-8 character, since continuation bytes are always >= 0x80.
 */
export function completeLines(tail: Buffer): string | null {
  const lastNewline = tail.lastIndexOf(0x0a);
  if (lastNewline < 0) return null;
  return tail.toString("utf-8", 0, lastNewline + 1);
}

/**
 * One upload of a batch. Returns an outcome rather than throwing; `retryable`
 * separates transient failures (network, 5xx, 429) from permanent 4xx ones.
 * The caller advances each file's marker to the returned `stored` size.
 */
export async function syncLogBatchOnce(
  deps: LogSyncDeps,
  files: LogChunk[]
): Promise<LogBatchOutcome> {
  const key = deps.readKey();
  if (key == null || key.trim().length === 0)
    return { status: "skipped", reason: "no-key" };
  if (files.length === 0) return { status: "skipped", reason: "empty" };

  const payload = {
    device_id: deps.deviceId(),
    client_version: deps.clientVersion(),
    environment: deps.environment(),
    files,
  };
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
      body: JSON.stringify(payload),
      signal: controller.signal,
    });

    if (resp.ok) {
      const body = (await resp.json().catch(() => ({}))) as {
        results?: LogFileResult[];
      };
      return {
        status: "ok",
        results: Array.isArray(body.results) ? body.results : [],
      };
    }

    const retryable = resp.status >= 500 || resp.status === 429;
    return { status: "error", reason: `http ${resp.status}`, retryable };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { status: "error", reason, retryable: true };
  } finally {
    clearTimeout(timer);
  }
}

export interface RetryOptions {
  maxAttempts?: number;
  baseBackoffMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

/** Retry wrapper: retries only transient failures with exponential backoff. */
export async function syncLogBatchWithRetry(
  deps: LogSyncDeps,
  files: LogChunk[],
  options: RetryOptions = {}
): Promise<LogBatchOutcome> {
  const maxAttempts = options.maxAttempts ?? 5;
  const baseBackoffMs = options.baseBackoffMs ?? 2_000;
  const sleep =
    options.sleep ??
    ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));

  let last: LogBatchOutcome = {
    status: "error",
    reason: "not attempted",
    retryable: false,
  };
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    last = await syncLogBatchOnce(deps, files);
    if (last.status !== "error" || !last.retryable) return last;
    await sleep(baseBackoffMs * 2 ** attempt);
  }
  return last;
}
