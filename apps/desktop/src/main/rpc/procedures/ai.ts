import { ORPCError, withEventMeta } from "@orpc/server";

import type { AiHydration, StreamChunk } from "@abacus-ai/contract/contract";

import type { SequencedChunk } from "../ai/source";
import { impl } from "./impl";

/**
 * A resume point: the seq of the last event the client saw. Anything else
 * (another format, a negative number) is treated as a point the ring cannot
 * serve, so the client is told to resync rather than silently replayed from
 * the start.
 */
const afterSeqOf = (lastEventId: string | undefined): number | null => {
  if (lastEventId == null || lastEventId === "") return null;
  const seq = Number(lastEventId);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : -1;
};

/**
 * Each event carries its seq as the SSE-style event id, which the client's
 * retry plugin sends back as `lastEventId` on a reconnect. Control yields
 * (null seq) carry none.
 */
async function* withSeqIds(
  chunks: AsyncIterable<SequencedChunk>
): AsyncGenerator<StreamChunk, void, unknown> {
  for await (const { seq, event } of chunks)
    yield seq == null ? event : withEventMeta(event, { id: String(seq) });
}

/**
 * `limit`/`before` over the completed transcript (newest last), and the run
 * outcomes that belong to the returned window: those recorded after one of
 * its messages, plus, on the newest page, those recorded on an empty thread.
 * A `before` the transcript does not hold (it was cleared, or the cursor is
 * from elsewhere) is `NOT_FOUND`, never the newest page again.
 */
const page = (
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

/**
 * The AG-UI conversation, served from `deps.ai` (spec 00 A.3, spec 02 §14).
 * The source is asked before an iterator is returned, so an unavailable
 * source fails the call itself rather than the first read.
 */
export const aiRouter = impl.ai.router({
  subscribe: impl.ai.subscribe.handler(
    ({ input, context, signal, lastEventId }) =>
      withSeqIds(
        context.deps.ai.subscribe(
          input.threadId,
          afterSeqOf(input.lastEventId ?? lastEventId),
          signal ?? new AbortController().signal,
          input.epoch
        )
      )
  ),
  runFinished: impl.ai.runFinished.handler(
    ({ input, context, signal, lastEventId }) => {
      const afterSeq = afterSeqOf(input.lastEventId ?? lastEventId);
      const notices = context.deps.ai.runFinished(
        // An unreadable resume point replays nothing: the consumer continues.
        afterSeq != null && afterSeq < 0 ? null : afterSeq,
        signal ?? new AbortController().signal
      );
      return (async function* () {
        for await (const { seq, notice } of notices)
          yield withEventMeta(notice, { id: String(seq) });
      })();
    }
  ),
  attention: impl.ai.attention.handler(({ context, signal }) => {
    const events = context.deps.ai.attention(
      signal ?? new AbortController().signal
    );
    return (async function* () {
      yield* events;
    })();
  }),
  send: impl.ai.send.handler(async ({ input, context }) => {
    const result = await context.deps.ai.send(input);
    if (result.status === "started" || result.status === "queued")
      context.deps.notch?.broadcast({
        type: "reaction",
        sessionId: input.threadId,
        reaction: "wink",
      });
    return result;
  }),
  hydrate: impl.ai.hydrate.handler(async ({ input, context }) =>
    page(
      input.threadId,
      await context.deps.ai.hydrate(input.threadId),
      input.limit,
      input.before
    )
  ),
  joinRun: impl.ai.joinRun.handler(({ input, context, signal }) =>
    withSeqIds(
      context.deps.ai.joinRun(
        input.runId,
        signal ?? new AbortController().signal
      )
    )
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
