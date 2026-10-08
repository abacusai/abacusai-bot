/**
 * Hosted routine runs on this computer: a long-poll of the account's routine
 * lane (`/v1/abacusaibot_channels`, lane "routine"), linked to WhatsApp or
 * not. Each entry is one run the server timed. `routine_start` claims it (the
 * server lets one start per run, so a second delivery is dropped), the run
 * goes to a fresh unattended session, and `routine_result` hands back its
 * answer for the server to deliver. A run that fails or outlives its deadline
 * says nothing to anyone: the server records it, and it is never retried.
 *
 * Started only once the server says it keeps routines; an old server's lane
 * is never polled.
 */
import { randomUUID } from "node:crypto";

import {
  parseHostedRunAnswer,
  parseHostedRunRequest,
  type HostedRunRequest,
} from "#main/services/agent-tools/hosted-run";
import { backoffDelayMs } from "#main/services/messaging/connector";

type ChannelsCall = <T>(
  body: Record<string, unknown>,
  timeoutMs: number,
  signal?: AbortSignal
) => Promise<T>;

/** How one run ended, from ServiceHost.runUnattended. */
export interface UnattendedRunResult {
  outcome: "completed" | "failed" | "timeout" | "not-started";
  text: string;
  creditsOut?: boolean;
}

interface RoutineEntryRunnerDeps {
  call: ChannelsCall;
  /** Whether the user's Abacus key is set; the lane idles without one. */
  hasKey: () => boolean;
  run: (request: HostedRunRequest) => Promise<UnattendedRunResult>;
  /** Keeps the host's idle lease fresh while a run is on. */
  activity: () => void;
  log?: (line: string) => void;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** A lane entry, as the server sends it. */
interface RoutineLaneEntry {
  kind?: string;
  handle?: string;
  routine?: unknown;
}

/** The server holds an inbox poll open for at most this long. */
const INBOX_WAIT_SECS = 25;
const CALL_TIMEOUT_MS = 20_000;
/** How often to look for a key while signed out. */
const KEY_WAIT_MS = 5_000;
/** The lease is renewed this often while a run is on. */
const ACTIVITY_MS = 60_000;

export class RoutineEntryRunner {
  private readonly log: (line: string) => void;
  private running = false;
  private pollAbort: AbortController | null = null;
  /** Names this start to the server, so a replaced host's poll stops taking runs. */
  private poller = randomUUID();
  /** Runs on now, by handle. */
  private readonly inFlight = new Map<string, Promise<void>>();

  constructor(private readonly deps: RoutineEntryRunnerDeps) {
    this.log = deps.log ?? ((line) => console.log(line));
  }

  /** A run is on: the host must stay up for it. */
  get busy(): boolean {
    return this.inFlight.size > 0;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.poller = randomUUID();
    void this.pollLoop();
  }

  stop(): void {
    this.running = false;
    this.pollAbort?.abort();
  }

  /** Every run on now, settled: for tests and an orderly stop. */
  async idle(): Promise<void> {
    await Promise.allSettled(this.inFlight.values());
  }

  private async pollLoop(): Promise<void> {
    let failures = 0;
    while (this.running) {
      if (!this.deps.hasKey()) {
        await sleep(KEY_WAIT_MS);
        continue;
      }
      const abort = new AbortController();
      this.pollAbort = abort;
      try {
        const result = await this.deps.call<{ messages?: RoutineLaneEntry[] }>(
          {
            action: "inbox",
            wait: INBOX_WAIT_SECS,
            lane: "routine",
            poller: this.poller,
          },
          (INBOX_WAIT_SECS + 15) * 1000,
          abort.signal
        );
        failures = 0;
        for (const entry of result.messages ?? []) this.take(entry);
      } catch (error) {
        if (!this.running) return;
        failures += 1;
        this.log(
          `[routines] lane poll failed (attempt ${failures}): ${describe(error)}`
        );
        await sleep(backoffDelayMs(failures));
      } finally {
        if (this.pollAbort === abort) this.pollAbort = null;
      }
    }
  }

  /** One entry: claimed and run in the background, once per handle. */
  take(entry: RoutineLaneEntry): void {
    const handle = typeof entry.handle === "string" ? entry.handle : null;
    if (handle == null || this.inFlight.has(handle)) return;
    if (entry.kind != null && entry.kind !== "routine") return;
    const request = parseHostedRunRequest(entry.routine);
    if (request == null) {
      this.log(`[routines] entry ${handle} carries no routine; dropped`);
      return;
    }
    const run = this.runEntry(handle, request).finally(() => {
      this.inFlight.delete(handle);
    });
    this.inFlight.set(handle, run);
  }

  private async runEntry(
    handle: string,
    request: HostedRunRequest
  ): Promise<void> {
    // The server's start CAS: one start per run, whatever was delivered twice.
    let started: { result?: string };
    try {
      started = await this.deps.call<{ result?: string }>(
        { action: "routine_start", handle },
        CALL_TIMEOUT_MS
      );
    } catch (error) {
      this.log(`[routines] could not start ${handle}: ${describe(error)}`);
      return;
    }
    if (started.result !== "ok") return;
    // The run's whole time, its answer's delivery included.
    const deadline = this.now() + request.deadlineSecs * 1000;

    this.deps.activity();
    const keepAlive = setInterval(() => this.deps.activity(), ACTIVITY_MS);
    keepAlive.unref?.();
    let result: UnattendedRunResult;
    try {
      result = await this.deps.run(request);
    } catch (error) {
      this.log(`[routines] run ${handle} threw: ${describe(error)}`);
      result = { outcome: "failed", text: "" };
    } finally {
      clearInterval(keepAlive);
    }

    // A run past its deadline is the server's to record; nothing goes back.
    if (result.outcome === "timeout") return;
    const body =
      result.outcome === "completed"
        ? {
            action: "routine_result",
            handle,
            ...parseHostedRunAnswer(result.text, request.notify),
          }
        : {
            action: "routine_result",
            handle,
            deliver: false,
            text: "",
            // A run that never started is this computer's trouble, not the
            // routine's: it must not count toward pausing it.
            failure:
              result.creditsOut === true
                ? "payment_required"
                : result.outcome === "not-started"
                  ? "infra_failure"
                  : "failed",
          };
    // The answer is worth its run: tried again until the deadline.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.deps.call(body, CALL_TIMEOUT_MS);
        return;
      } catch (error) {
        // A server that does not take this answer will not take it later.
        if (describe(error).includes("routine_result takes")) {
          this.log(
            `[routines] result for ${handle} refused: ${describe(error)}`
          );
          return;
        }
        const wait = Math.min(2_000 * 2 ** attempt, 60_000);
        if (this.now() + wait >= deadline) {
          this.log(
            `[routines] result for ${handle} not sent: ${describe(error)}`
          );
          return;
        }
        await this.sleep(wait);
      }
    }
  }

  private now(): number {
    return (this.deps.now ?? Date.now)();
  }

  private sleep(ms: number): Promise<void> {
    return (this.deps.sleep ?? sleep)(ms);
  }
}

const describe = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms).unref?.();
  });
