/**
 * The seam between the `ai.*` procedures and whatever produces the AG-UI
 * stream (spec 00 A.3). The AG-UI emitter slice implements it; until then the
 * app mounts `UnavailableAguiSource`, and tests mount fakes.
 */
import type {
  AiSendInput,
  ChatHydrationResult,
  StreamChunk,
} from "#shared/contract";

import { unavailable } from "../errors";

export interface SequencedChunk {
  seq: number;
  event: StreamChunk;
}

export interface AguiSource {
  /** Replay after `afterSeq` (null: from the ring's start), then live. */
  subscribe(
    threadId: string,
    afterSeq: number | null,
    signal: AbortSignal
  ): AsyncIterable<SequencedChunk>;
  /** From `RUN_STARTED`, then live, ending after `RUN_FINISHED`/`RUN_ERROR`. */
  joinRun(runId: string, signal: AbortSignal): AsyncIterable<SequencedChunk>;
  send(input: AiSendInput): Promise<{ runId: string }>;
  /** Authoritative live state for one thread: the in-flight run and its interrupts. */
  liveState(threadId: string): {
    activeRun: { runId: string } | null;
    interrupts: ChatHydrationResult["interrupts"];
  };
  cancel(threadId: string, runId?: string): Promise<void>;
}

/** What `ai.hydrate` reads persisted messages from (the thread store, sub-slice C). */
export interface ThreadReader {
  readCurrent(threadId: string): Promise<ChatHydrationResult["messages"]>;
}

const notYet = (): never => {
  throw unavailable("The AG-UI emitter has not landed yet");
};

/** Every `ai.*` call answers `UNAVAILABLE` until the emitter lands. */
export class UnavailableAguiSource implements AguiSource {
  subscribe(): AsyncIterable<SequencedChunk> {
    return notYet();
  }

  joinRun(): AsyncIterable<SequencedChunk> {
    return notYet();
  }

  send(): Promise<{ runId: string }> {
    return Promise.reject(unavailable("The AG-UI emitter has not landed yet"));
  }

  liveState(): ReturnType<AguiSource["liveState"]> {
    return notYet();
  }

  cancel(): Promise<void> {
    return Promise.reject(unavailable("The AG-UI emitter has not landed yet"));
  }
}
