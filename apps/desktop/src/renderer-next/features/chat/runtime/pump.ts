/**
 * The pump (spec 02 §3.4): one per generation, the only reader of the
 * server. `ai.joinRun` from the active run's `RUN_STARTED` (when the
 * snapshot has one), then `ai.subscribe` after the last accepted seq. It
 * owns the connection state and decides recovery (§3.3); it never touches
 * the store or the client, only the dispatcher.
 */
import type { StreamChunk } from "@tanstack/ai";

import {
  controlOf,
  eventSeq,
  isNotFound,
  resumePoint,
  type AiClient,
} from "#next/data/ai";

import { isTerminal, terminalRunId } from "../store/apply";

export type ConnectionState =
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

interface PumpPositions {
  /** The checkpoint `N`. */
  readonly checkpoint: number;
  /** The last seq accepted from the server. */
  receivedSeq: number;
  /** The relay's lifetime at the checkpoint; a resume from another answers resync. */
  readonly epoch: string | null;
}

export interface PumpOptions {
  ai: AiClient;
  threadId: string;
  activeRunId: string | null;
  positions: PumpPositions;
  signal: AbortSignal;
  push(seq: number, event: StreamChunk): void;
  onConnection(state: ConnectionState): void;
  /** `abacus.resync`, or a join that failed before the checkpoint: a new generation. */
  onRecover(reason: "resync" | "join-failed"): void;
  /** The thread is gone (`NOT_FOUND` from the subscription). */
  onNotFound(): void;
  /** Reconnect delays (§3.3); the last failure sets `"error"`. */
  retryDelaysMs?: readonly number[];
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Two waits, then the third failure sets `"error"` (§3.3, R2-T34). */
const RETRY_DELAYS_MS = [250, 1000] as const;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });

type Handled = "continue" | "stop";

export const runPump = async (options: PumpOptions): Promise<void> => {
  const {
    ai,
    threadId,
    activeRunId,
    positions,
    signal,
    push,
    onConnection,
    onRecover,
    onNotFound,
  } = options;
  const delays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
  const sleep = options.sleep ?? defaultSleep;
  let stopped = false;

  const accept = (event: StreamChunk): Handled => {
    if (signal.aborted || stopped) return "stop";
    const control = controlOf(event);
    if (control?.kind === "subscribed") {
      onConnection("connected");
      return "continue";
    }
    if (control?.kind === "resync") {
      stopped = true;
      onRecover("resync");
      return "stop";
    }
    const seq = eventSeq(event);
    if (seq == null || seq <= positions.receivedSeq) return "continue";
    positions.receivedSeq = seq;
    push(seq, event);
    return "continue";
  };

  const caughtUp = (): boolean => positions.receivedSeq >= positions.checkpoint;

  if (activeRunId != null) {
    let terminal = false;
    let first = true;
    try {
      const iterator = await ai.joinRun({ runId: activeRunId }, { signal });
      for await (const event of iterator) {
        if (first) {
          first = false;
          onConnection("connected");
        }
        if (accept(event) === "stop") return;
        if (isTerminal(event) && terminalRunId(event) === activeRunId)
          terminal = true;
      }
    } catch {
      if (signal.aborted) return;
      if (!caughtUp()) {
        stopped = true;
        onRecover("join-failed");
        return;
      }
    }
    if (signal.aborted || stopped) return;
    // Never switch to `subscribe` below the checkpoint (review r1-7).
    if (!terminal && !caughtUp()) {
      stopped = true;
      onRecover("join-failed");
      return;
    }
  }

  let failures = 0;
  while (!signal.aborted && !stopped) {
    try {
      const iterator = await ai.subscribe(
        {
          threadId,
          lastEventId: resumePoint(positions.receivedSeq),
          ...(positions.epoch != null ? { epoch: positions.epoch } : {}),
        },
        { signal }
      );
      for await (const event of iterator) {
        if (controlOf(event)?.kind === "subscribed") failures = 0;
        if (accept(event) === "stop") return;
      }
      throw new Error("chat: the subscription ended");
    } catch (error) {
      if (signal.aborted || stopped) return;
      if (isNotFound(error)) {
        onConnection("error");
        onNotFound();
        return;
      }
      failures += 1;
      if (failures > delays.length) {
        onConnection("error");
        return;
      }
      onConnection("reconnecting");
      await sleep(delays[failures - 1]!, signal);
    }
  }
};
