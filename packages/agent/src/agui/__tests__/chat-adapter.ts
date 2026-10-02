/**
 * A SubscribeConnectionAdapter over a live in-process AguiHost: what main's
 * relay does for one renderer window (spec §5.2), reduced to the parts the
 * ChatClient tests need. `send` writes `run`; a `queued` or `rejected` ack is
 * answered with a RUN_ERROR injected into this subscription only (§3.1.6).
 */
import { EventType } from "@ag-ui/core";
import type {
  QueueStrategy,
  SubscribeConnectionAdapter,
} from "@tanstack/ai-client";

import { aguiEvent } from "../event.js";
import type { AguiEvent } from "../wire.js";
import { runInput, type Live } from "./live.js";

/**
 * The ChatClient busy guard spec §3.1.6 prescribes. ai-client 0.36 has no
 * `whenBusy: "error"` (`WhenBusy` is `queue | drop | interrupt`, and `drop`
 * returns silently), but `decideWhenBusy` calls a strategy function
 * synchronously inside `sendMessage`, so a strategy that throws makes the
 * accidental busy send reject: loud, and nothing is queued locally or sent.
 * Busy input belongs to `ai.queue.enqueue`, never to `sendMessage`. A caller
 * must not pass a per-call `whenBusy`, which bypasses the strategy.
 */
export const failLoudlyWhenBusy: QueueStrategy = ({ busyReason }) => {
  throw new BusySendError(busyReason);
};

export class BusySendError extends Error {
  constructor(readonly busyReason: string) {
    super(
      `sendMessage while the thread is busy (${busyReason}); busy input goes to the host queue (ai.queue.enqueue)`
    );
    this.name = "BusySendError";
  }
}

export function hostAdapter(
  l: Live,
  threadId = "t-1"
): SubscribeConnectionAdapter {
  const subscribers = new Set<(event: AguiEvent) => void>();
  const inject = (event: AguiEvent): void => {
    for (const push of subscribers) push(event);
  };

  l.onEvent((event) => inject(event));

  return {
    subscribe: (signal?: AbortSignal) => ({
      [Symbol.asyncIterator]: () => {
        const buffered: AguiEvent[] = [];
        let wake: (() => void) | undefined;
        const push = (event: AguiEvent): void => {
          buffered.push(event);
          wake?.();
        };

        subscribers.add(push);
        signal?.addEventListener("abort", () => {
          subscribers.delete(push);
          wake?.();
        });

        return {
          next: async (): Promise<IteratorResult<never>> => {
            while (buffered.length === 0) {
              if (signal?.aborted) return { done: true, value: undefined };
              await new Promise<void>((resolve) => (wake = resolve));
              wake = undefined;
            }

            return { done: false, value: buffered.shift() as never };
          },
          return: async (): Promise<IteratorResult<never>> => {
            subscribers.delete(push);

            return { done: true, value: undefined };
          },
        };
      },
    }),
    send: async (messages, _data, _signal, context) => {
      const runId = context?.runId ?? "run-x";

      // What ChatClient hands the adapter (UIMessages with `parts`), passed
      // through unconverted: the host reads that shape itself.
      l.send(runInput(runId, "", { messages: [...messages] }));

      // main's ai.send: follow the ack for this request.
      await l.waitFor(
        (events) =>
          events.some(
            (event) =>
              event.type === "CUSTOM" &&
              event.name === "run.ack" &&
              (event.value as { runId?: string }).runId === runId
          ),
        `ack for ${runId}`
      );
      const ack = l
        .custom<{ runId: string; status: string; reason?: string }>("run.ack")
        .find((value) => value.runId === runId)!;

      if (ack.status === "queued" || ack.status === "rejected") {
        const queued = ack.status === "queued";

        // Per-subscription only: never written to the log or another window.
        const error = aguiEvent(EventType.RUN_ERROR, {
          message: queued
            ? "Queued behind the running reply."
            : (ack.reason ?? "rejected"),
          code: queued ? "queued" : "rejected",
          metadata: { tanstack: { threadId, runId } },
        });

        queueMicrotask(() => {
          for (const push of subscribers) push(error);
        });
      }
    },
  };
}
