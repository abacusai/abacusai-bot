/**
 * The seam between the `ai.*` procedures and whatever produces the AG-UI
 * stream (spec 00 A.3, spec 02 §14). The app mounts main's AG-UI relay
 * (`services/agui/relay-service.ts`); tests mount it or a fake;
 * `UnavailableAguiSource` answers `UNAVAILABLE` for deps that have neither.
 */
import type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  PermissionDescriptor,
  StreamChunk,
  UIMessage,
} from "#shared/contract";

import { unavailable } from "../errors";

/**
 * One relay event and its seq. A null seq is a control yield
 * (`abacus.subscribed`, `abacus.resync`): it carries no event id, so a
 * retry's `lastEventId` never moves past what the client really saw.
 */
export interface SequencedChunk {
  seq: number | null;
  event: StreamChunk;
}

export type PermissionLineage =
  PermissionDescriptor["metadata"]["abacus"]["lineage"];

export interface AiRespondPermissionInput {
  threadId: string;
  lineage: PermissionLineage;
  decision: unknown;
}

export interface AguiSource {
  /** Events with seq `> afterSeq` (null: the ring's start), then live. */
  subscribe(
    threadId: string,
    afterSeq: number | null,
    signal: AbortSignal
  ): AsyncIterable<SequencedChunk>;
  /** From `RUN_STARTED` through the terminal, then returns. */
  joinRun(runId: string, signal: AbortSignal): AsyncIterable<SequencedChunk>;
  send(input: AiSendInput): Promise<AiSendAck>;
  /** The whole completed transcript plus the checkpoint; the procedure pages it. */
  hydrate(threadId: string): Promise<AiHydration>;
  cancel(threadId: string, runId?: string): Promise<void>;
  respondPermission(input: AiRespondPermissionInput): Promise<void>;
  queue: {
    enqueue(threadId: string, message: string): Promise<void>;
    update(input: {
      threadId: string;
      incarnation: string;
      entryId: string;
      message: string;
    }): Promise<void>;
    remove(input: {
      threadId: string;
      incarnation: string;
      entryId: string;
    }): Promise<void>;
    clear(threadId: string): Promise<void>;
    dequeue(threadId: string): Promise<void>;
  };
}

/** Where persisted history comes from (the thread store, sub-slice C). */
export interface ThreadReader {
  readCurrent(threadId: string): Promise<UIMessage[]>;
}

const MESSAGE = "The AG-UI relay is not mounted";

const notYet = (): never => {
  throw unavailable(MESSAGE);
};

const rejected = (): Promise<never> => Promise.reject(unavailable(MESSAGE));

/** Every `ai.*` call answers `UNAVAILABLE`. */
export class UnavailableAguiSource implements AguiSource {
  subscribe(): AsyncIterable<SequencedChunk> {
    return notYet();
  }

  joinRun(): AsyncIterable<SequencedChunk> {
    return notYet();
  }

  send(): Promise<AiSendAck> {
    return rejected();
  }

  hydrate(): Promise<AiHydration> {
    return rejected();
  }

  cancel(): Promise<void> {
    return rejected();
  }

  respondPermission(): Promise<void> {
    return rejected();
  }

  readonly queue = {
    enqueue: rejected,
    update: rejected,
    remove: rejected,
    clear: rejected,
    dequeue: rejected,
  };
}
