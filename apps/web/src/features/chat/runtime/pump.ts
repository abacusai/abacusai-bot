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
} from "#renderer/data/ai";
import { untilOpen, type ConnectionSource } from "#renderer/data/queries/live";

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
  /** First sequenced live event after subscribe; excludes subscribed/resync. */
  onLive?(): void;
  /** Reconnect delays (§3.3); the last failure sets `"error"`. */
  retryDelaysMs?: readonly number[];
  /**
   * The transport (spec 09 D3): a failure while its socket is down, or on a
   * socket since replaced, does not count against the retry budget; the
   * pump waits for the next socket and resumes from its position.
   */
  connection?: ConnectionSource;
  /**
   * The host closed the socket for an oversized frame (1009) while this
   * stream was replaying (behind the head it was subscribed at, or a join
   * below its checkpoint) and had delivered nothing on that socket: the
   * frame was most likely this stream's next event. The session counts
   * these across pumps and hydrations; `true` stops the stream (replaying
   * it would close the next socket too) until the user's Retry. A 1009 the
   * stream cannot be blamed for (it was caught up: another stream, a query
   * or a DB frame) only reconnects, as any drop.
   */
  onCut?(): boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
}

/** Close code 1009: an event larger than the host's frame limit. */
const OVERSIZED = 1009;

/** Two waits, then the third failure sets `"error"` (§3.3, R2-T34). */
const RETRY_DELAYS_MS = [250, 1000, 4000] as const;

const defaultSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) finish();
  });

type Handled = "continue" | "accepted" | "stop";

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
  // The head this subscription replays up to (`abacus.subscribed`).
  let replayTo = positions.checkpoint;

  const accept = (event: StreamChunk): Handled => {
    if (signal.aborted || stopped) return "stop";
    const control = controlOf(event);
    if (control?.kind === "subscribed") {
      replayTo = control.seq ?? positions.receivedSeq;
      // Another host lifetime: the `abacus.resync` that follows decides.
      if (
        control.epoch != null &&
        positions.epoch != null &&
        control.epoch !== positions.epoch
      )
        return "continue";
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
    return "accepted";
  };

  const caughtUp = (): boolean => positions.receivedSeq >= positions.checkpoint;

  const { connection } = options;
  /** The socket went away under this attempt: not the stream's fault. */
  const dropped = (generation: number | undefined): boolean =>
    connection != null &&
    connection.state !== "closed" &&
    (connection.state !== "open" || connection.generation !== generation);
  /** A 1009 close this stream is to blame for (see `onCut`). */
  const cut = (generation: number | undefined, delivered: boolean): boolean =>
    generation != null &&
    connection?.closeCode?.(generation) === OVERSIZED &&
    !delivered &&
    positions.receivedSeq < replayTo;
  const stopForCut = (): boolean => {
    if (options.onCut?.() !== true) return false;
    stopped = true;
    onConnection("error");
    return true;
  };

  if (activeRunId != null) {
    let terminal = false;
    let first = true;
    const generation = connection?.generation;
    const before = positions.receivedSeq;
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
      // A join replays from the run's start, up to the checkpoint at least.
      if (cut(generation, positions.receivedSeq > before) && stopForCut())
        return;
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
    const generation = connection?.generation;
    let delivered = false;
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
        const handled = accept(event);
        if (handled === "stop") return;
        if (handled === "accepted") {
          failures = 0;
          delivered = true;
          options.onLive?.();
        }
      }
      throw new Error("chat: the subscription ended");
    } catch (error) {
      if (signal.aborted || stopped) return;
      if (isNotFound(error)) {
        onConnection("error");
        onNotFound();
        return;
      }
      if (dropped(generation)) {
        if (cut(generation, delivered) && stopForCut()) return;
        onConnection("reconnecting");
        await untilOpen(connection!, signal);
        continue;
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
