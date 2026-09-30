/**
 * Runs (spec §3.1): every `session.send` is owned by an immutable TurnToken,
 * `RUN_STARTED` is written only by `open`, and every open run gets exactly one
 * terminal from the first owner-valid `settle`.
 */
import { EventType } from "@ag-ui/core";

import type { TurnUsage } from "../turn-usage.js";
import { aguiEvent } from "./event.js";
import { toFinishReason } from "./vendor/pi-acp/stop-reason.js";
import type {
  AgentErrorPayload,
  AguiEvent,
  PiStopReason,
  RunErrorMeta,
  RunFinishedMeta,
} from "./wire.js";

export interface TurnToken {
  readonly seq: number;
  /** The client's run id for a `run`; absent for host-started turns until opened. */
  readonly runId?: string;
}

interface OpenRun {
  token: TurnToken;
  runId: string;
  serverInitiated: boolean;
  cancelling: boolean;
  failure?: AgentErrorPayload;
  usage?: TurnUsage;
  stopReason?: string;
}

export interface RunControllerDeps {
  threadId: string;
  /** Writes one AG-UI event to stdout (through the sink's filters). */
  write: (event: AguiEvent) => void;
  /** The open parts to close before a terminal, in §3.1.5 order. */
  closeOpenParts: (cancelled: boolean) => AguiEvent[];
  /** The model reference the run's terminal names. */
  model: () => string;
  /** Right after RUN_STARTED is written. */
  onOpen?: () => void;
}

/** `TurnUsage` as @ag-ui/core accounts it: input includes the cache (§3.3.8). */
export function toTokenUsage(usage: TurnUsage) {
  const inputTokens = usage.input + usage.cacheRead + usage.cacheWrite;

  return [
    {
      ...(usage.model != null ? { model: usage.model } : {}),
      inputTokens,
      cachedInputTokens: usage.cacheRead,
      cacheWriteInputTokens: usage.cacheWrite,
      outputTokens: usage.output,
      totalTokens: inputTokens + usage.output,
    },
  ];
}

export function errorMessageOf(error: AgentErrorPayload): string {
  return (
    error.message ??
    error.segmentData?.message ??
    "The agent reported an error."
  );
}

export class RunController {
  private seq = 0;
  /** The send in flight: what permission lineage binds to (§3.5.3). */
  private current: TurnToken | null = null;
  private run: OpenRun | null = null;
  private readonly seenRunIds = new Set<string>();
  /** Terminal outcome per run id, for retry/regenerate decisions (§3.1.4). */
  private readonly outcomes = new Map<
    string,
    "success" | "error" | "cancelled"
  >();

  constructor(private readonly deps: RunControllerDeps) {}

  mint(runId?: string): TurnToken {
    this.seq += 1;

    return runId != null ? { seq: this.seq, runId } : { seq: this.seq };
  }

  /** The token of the send in flight; stays set until `send()` resolves. */
  setCurrent(token: TurnToken | null): void {
    this.current = token;
  }

  currentToken(): TurnToken | null {
    return this.current;
  }

  isOpen(): boolean {
    return this.run != null;
  }

  openRunId(): string | undefined {
    return this.run?.runId;
  }

  openToken(): TurnToken | undefined {
    return this.run?.token;
  }

  hasSeen(runId: string): boolean {
    return this.seenRunIds.has(runId);
  }

  outcomeOf(runId: string): "success" | "error" | "cancelled" | undefined {
    return this.outcomes.get(runId);
  }

  isCancelling(token: TurnToken): boolean {
    return this.run?.token.seq === token.seq && this.run.cancelling;
  }

  /**
   * The only writer of RUN_STARTED. The client's RunAgentInput is not echoed:
   * it carries the whole history on every turn (O(transcript) bytes per run
   * into main's log and ring). The run's new user message goes out as its
   * own TEXT_MESSAGE_* right after.
   */
  open(
    token: TurnToken,
    runId: string,
    options: { serverInitiated: boolean }
  ): void {
    if (this.run != null) {
      throw new Error(
        `run ${this.run.runId} is still open; cannot open ${runId}`
      );
    }

    this.seenRunIds.add(runId);
    this.run = {
      token,
      runId,
      serverInitiated: options.serverInitiated,
      cancelling: false,
    };
    this.deps.write(
      aguiEvent(EventType.RUN_STARTED, {
        threadId: this.deps.threadId,
        runId,
        ...(options.serverInitiated
          ? { metadata: { abacus: { serverInitiated: true } } }
          : {}),
      })
    );
    this.deps.onOpen?.();
  }

  /** Synchronously, before any abort is awaited (§3.1.2). */
  markCancelling(token?: TurnToken | null): void {
    if (this.run == null) return;
    if (token != null && token.seq !== this.run.token.seq) return;
    this.run.cancelling = true;
  }

  /** A `turn`-origin failure: the first one becomes the terminal. */
  recordFailure(error: AgentErrorPayload): boolean {
    if (this.run == null || this.run.failure != null) return false;
    this.run.failure = error;

    return true;
  }

  /**
   * A failure of the send `token` owns: recorded only while that token's own
   * run is open and has no failure yet. A thrown command never fails another
   * command's run (spec §2.1).
   */
  recordFailureFor(
    token: TurnToken | null | undefined,
    error: AgentErrorPayload
  ): boolean {
    if (token == null || this.run?.token.seq !== token.seq) return false;

    return this.recordFailure(error);
  }

  recordUsage(usage: TurnUsage): void {
    if (this.run != null) this.run.usage = usage;
  }

  recordStopReason(stopReason: string | undefined): void {
    if (this.run != null && stopReason != null)
      this.run.stopReason = stopReason;
  }

  /** Closes the open run if `token` owns it; a no-op otherwise. */
  settle(token: TurnToken | null | undefined): void {
    if (token == null || this.run == null || this.run.token.seq !== token.seq) {
      return;
    }

    this.close();
  }

  /** Closes whatever run is open (reset, cancel before a send ever started). */
  settleOpen(): void {
    if (this.run != null) this.close();
  }

  /**
   * Last words for an open run when the process is going away. Synchronous
   * and idempotent; `writeSync` is how it reaches stdout at exit.
   */
  emergencyClose(
    code: "agent_crashed" | "agent_exit" | "compat_lost",
    writeSync: (event: AguiEvent) => void
  ): void {
    const run = this.run;

    if (run == null) return;
    this.run = null;
    this.outcomes.set(run.runId, "error");
    writeSync(
      aguiEvent(EventType.RUN_ERROR, {
        message:
          code === "compat_lost"
            ? "The agent lost its connection to the app."
            : "The agent stopped unexpectedly.",
        code,
        metadata: {
          tanstack: { threadId: this.deps.threadId, runId: run.runId },
          abacus: { error: { code } },
        } satisfies RunErrorMeta,
      })
    );
  }

  private close(): void {
    const run = this.run!;
    const cancelled = run.failure == null && run.cancelling;

    for (const event of this.deps.closeOpenParts(
      cancelled || run.failure != null
    )) {
      this.deps.write(event);
    }

    const model = this.deps.model();
    const usage = run.usage != null ? { usage: toTokenUsage(run.usage) } : {};

    if (run.failure != null) {
      this.outcomes.set(run.runId, "error");
      const meta: RunErrorMeta = {
        tanstack: {
          threadId: this.deps.threadId,
          runId: run.runId,
          ...(model.length > 0 ? { model } : {}),
        },
        abacus: {
          error: run.failure,
          ...(run.usage != null ? { turnUsage: run.usage } : {}),
        },
      };

      this.deps.write(
        aguiEvent(EventType.RUN_ERROR, {
          message: errorMessageOf(run.failure),
          ...(run.failure.code != null ? { code: run.failure.code } : {}),
          ...usage,
          metadata: meta,
        })
      );
    } else {
      const stopReason = (cancelled ? "aborted" : run.stopReason) as
        | PiStopReason
        | undefined;
      const meta: RunFinishedMeta = {
        tanstack: {
          ...(model.length > 0 ? { model } : {}),
          finishReason: cancelled ? null : toFinishReason(stopReason),
        },
        abacus: {
          ...(run.usage != null ? { turnUsage: run.usage } : {}),
          ...(stopReason != null ? { stopReason } : {}),
          ...(run.serverInitiated ? { serverInitiated: true as const } : {}),
        },
      };

      this.outcomes.set(run.runId, cancelled ? "cancelled" : "success");
      this.deps.write(
        aguiEvent(EventType.RUN_FINISHED, {
          threadId: this.deps.threadId,
          runId: run.runId,
          outcome: { type: cancelled ? "cancelled" : "success" },
          ...usage,
          metadata: meta,
        })
      );
    }

    this.run = null;
  }
}
