import { withEventMeta } from "@orpc/server";

import type { StreamChunk } from "#shared/contract";

import type { SequencedChunk } from "../ai/source";
import { unavailable } from "../errors";
import { impl } from "./impl";

/** A resume point: the seq of the last event the client saw. */
const afterSeqOf = (lastEventId: string | undefined): number | null => {
  if (lastEventId == null) return null;
  const seq = Number(lastEventId);
  return Number.isSafeInteger(seq) && seq >= 0 ? seq : null;
};

/**
 * Each event carries its seq as the SSE-style event id, which the client's
 * retry plugin sends back as `lastEventId` on a reconnect.
 */
async function* withSeqIds(
  chunks: AsyncIterable<SequencedChunk>
): AsyncGenerator<StreamChunk, void, unknown> {
  for await (const { seq, event } of chunks)
    yield withEventMeta(event, { id: String(seq) });
}

/**
 * The AG-UI conversation, served from `deps.ai` (spec 00 A.3). The source is
 * asked before the iterator is returned, so an unavailable source fails the
 * call itself rather than the first read.
 */
export const aiRouter = impl.ai.router({
  subscribe: impl.ai.subscribe.handler(
    ({ input, context, signal, lastEventId }) => {
      const chunks = context.deps.ai.subscribe(
        input.threadId,
        afterSeqOf(input.lastEventId ?? lastEventId),
        signal ?? new AbortController().signal
      );
      return withSeqIds(chunks);
    }
  ),
  send: impl.ai.send.handler(({ input, context }) =>
    context.deps.ai.send(input)
  ),
  hydrate: impl.ai.hydrate.handler(async ({ input, context }) => {
    const { threads, ai } = context.deps;
    if (threads == null)
      throw unavailable("The thread store has not landed yet");

    // What was said, from the thread store; what is running, from the source.
    const messages = await threads.readCurrent(input.threadId);
    const { activeRun, interrupts } = ai.liveState(input.threadId);

    let end = messages.length;
    if (input.before != null) {
      const index = messages.findIndex(
        (message) => message.id === input.before
      );
      if (index !== -1) end = index;
    }
    const start = input.limit == null ? 0 : Math.max(0, end - input.limit);
    const page = messages.slice(start, end);
    const first = page[0];

    return {
      messages: page,
      activeRun,
      interrupts,
      // Newest last; the cursor is sent back as `before` for the older page.
      page:
        start > 0 && first != null
          ? { truncated: true as const, cursor: first.id }
          : { truncated: false as const },
    };
  }),
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
});
