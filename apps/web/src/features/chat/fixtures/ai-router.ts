/**
 * The `ai.*` procedures over an `AguiSource`, for the fixture relay (spec 02
 * §11.1): the contract implemented as main's `rpc/procedures/ai.ts` does it
 * (paging by `limit`/`before` with the window's run outcomes, seq event ids,
 * `lastEventId` parsing), with the same `{ deps: { ai } }` context. The
 * renderer program cannot import main (spec 01 §3.4), so this is a
 * copy; the spec's memory-transport rows run main's own router instead
 * (`test-support/chat-relay.ts`).
 */
import { implement, ORPCError, withEventMeta } from "@orpc/server";
import type { StreamChunk } from "@tanstack/ai";

import { contract } from "@abacus-ai/contract/contract";
import type {
  AiHydration,
  AiSendAck,
  AiSendInput,
  AttentionEvent,
  RunFinishedNotice,
} from "@abacus-ai/contract/contract";

/** One relay event and its seq; a null seq is a control yield. */
export interface SequencedChunk {
  seq: number | null;
  event: StreamChunk;
}

/**
 * Main's `AguiSource` (`main/rpc/ai/source.ts`), restated: the seam between
 * the `ai.*` procedures and whatever produces the stream.
 */
export interface AguiSourceLike {
  subscribe(
    threadId: string,
    afterSeq: number | null,
    signal: AbortSignal,
    epoch?: string
  ): AsyncIterable<SequencedChunk>;
  joinRun(runId: string, signal: AbortSignal): AsyncIterable<SequencedChunk>;
  runFinished(
    afterSeq: number | null,
    signal: AbortSignal
  ): AsyncIterable<{ seq: number; notice: RunFinishedNotice }>;
  attention(signal: AbortSignal): AsyncIterable<AttentionEvent>;
  send(input: AiSendInput): Promise<AiSendAck>;
  hydrate(threadId: string): Promise<AiHydration>;
  cancel(threadId: string, runId?: string): Promise<void>;
  respondPermission(input: {
    threadId: string;
    lineage: unknown;
    decision: unknown;
  }): Promise<void>;
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

interface AiRouterContext {
  deps: { ai: AguiSourceLike };
}

const afterSeqOf = (lastEventId: string | undefined): number | null => {
  if (lastEventId == null || lastEventId === "") return null;
  const seq = Number(lastEventId);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : -1;
};

async function* withSeqIds(
  chunks: AsyncIterable<SequencedChunk>
): AsyncGenerator<StreamChunk, void, unknown> {
  for await (const { seq, event } of chunks)
    yield seq == null ? event : withEventMeta(event, { id: String(seq) });
}

/** Main's `page()`: the window, its outcomes, and the older-page cursor. */
const pageOf = (
  threadId: string,
  hydration: AiHydration,
  limit: number | undefined,
  before: string | undefined
): AiHydration => {
  const { messages } = hydration;
  let end = messages.length;
  if (before != null) {
    end = messages.findIndex((message) => message.id === before);
    if (end === -1)
      throw new ORPCError("NOT_FOUND", {
        status: 404,
        message: `No message ${before} in thread ${threadId}`,
        data: { entity: "thread", id: threadId },
      });
  }
  const start = limit == null ? 0 : Math.max(0, end - limit);
  const window = messages.slice(start, end);
  const ids = new Set(window.map((message) => message.id));
  const newest = end === messages.length;
  const first = window[0];
  return {
    ...hydration,
    messages: window,
    abacus: {
      ...hydration.abacus,
      runOutcomes: hydration.abacus.runOutcomes.filter((outcome) =>
        outcome.afterMessageId == null
          ? newest
          : ids.has(outcome.afterMessageId)
      ),
    },
    page:
      start > 0 && first != null
        ? { truncated: true as const, cursor: first.id }
        : { truncated: false as const },
  };
};

const impl = implement(contract).$context<AiRouterContext>();
const noSignal = (): AbortSignal => new AbortController().signal;

export const fixtureAiRouter = impl.ai.router({
  subscribe: impl.ai.subscribe.handler(
    ({ input, context, signal, lastEventId }) =>
      withSeqIds(
        context.deps.ai.subscribe(
          input.threadId,
          afterSeqOf(input.lastEventId ?? lastEventId),
          signal ?? noSignal(),
          input.epoch
        )
      )
  ),
  runFinished: impl.ai.runFinished.handler(
    ({ input, context, signal, lastEventId }) => {
      const afterSeq = afterSeqOf(input.lastEventId ?? lastEventId);
      const notices = context.deps.ai.runFinished(
        afterSeq != null && afterSeq < 0 ? null : afterSeq,
        signal ?? noSignal()
      );
      return (async function* () {
        for await (const { seq, notice } of notices)
          yield withEventMeta(notice, { id: String(seq) });
      })();
    }
  ),
  attention: impl.ai.attention.handler(({ context, signal }) => {
    const events = context.deps.ai.attention(signal ?? noSignal());
    return (async function* () {
      yield* events;
    })();
  }),
  send: impl.ai.send.handler(({ input, context }) =>
    context.deps.ai.send(input)
  ),
  hydrate: impl.ai.hydrate.handler(async ({ input, context }) =>
    pageOf(
      input.threadId,
      await context.deps.ai.hydrate(input.threadId),
      input.limit,
      input.before
    )
  ),
  joinRun: impl.ai.joinRun.handler(({ input, context, signal }) =>
    withSeqIds(context.deps.ai.joinRun(input.runId, signal ?? noSignal()))
  ),
  cancel: impl.ai.cancel.handler(({ input, context }) =>
    context.deps.ai.cancel(input.threadId, input.runId)
  ),
  respondPermission: impl.ai.respondPermission.handler(({ input, context }) =>
    context.deps.ai.respondPermission(input)
  ),
  queue: {
    enqueue: impl.ai.queue.enqueue.handler(({ input, context }) =>
      context.deps.ai.queue.enqueue(input.threadId, input.message)
    ),
    update: impl.ai.queue.update.handler(({ input, context }) =>
      context.deps.ai.queue.update(input)
    ),
    remove: impl.ai.queue.remove.handler(({ input, context }) =>
      context.deps.ai.queue.remove(input)
    ),
    clear: impl.ai.queue.clear.handler(({ input, context }) =>
      context.deps.ai.queue.clear(input.threadId)
    ),
    dequeue: impl.ai.queue.dequeue.handler(({ input, context }) =>
      context.deps.ai.queue.dequeue(input.threadId)
    ),
  },
});
