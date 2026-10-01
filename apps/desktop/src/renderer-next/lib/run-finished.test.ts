import { expect, it, vi } from "vitest";

import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract";

import { runFinishedFeed, subscribeRunFinished } from "./run-finished";

it("R6-T15 one iterator feeds three consumers, dedupes and closes after the last leaves", async () => {
  let receive:
    | ((notice: IteratorResult<RunFinishedNotice>) => void)
    | undefined;
  let signal: AbortSignal | undefined;
  const open = vi.fn(async (_input, options) => {
    signal = options.signal;
    const events = {
      [Symbol.asyncIterator]: () => ({
        next: () =>
          new Promise<IteratorResult<RunFinishedNotice>>((resolve) => {
            receive = resolve;
          }),
        return: async () => ({ done: true as const, value: undefined }),
      }),
    };
    signal?.addEventListener(
      "abort",
      () => receive?.({ done: true, value: undefined }),
      { once: true }
    );
    return events;
  });
  const transport = {
    state: "open",
    client: { ai: { runFinished: open } },
  } as unknown as Transport;
  const listeners = [vi.fn(), vi.fn(), vi.fn()];
  const stops = listeners.map((listener, index) =>
    index === 1
      ? subscribeRunFinished(transport, listener)
      : runFinishedFeed(transport).subscribe(listener)
  );
  for (let i = 0; i < 4; i += 1) await Promise.resolve();
  expect(open).toHaveBeenCalledOnce();
  const notice = {
    runId: "r",
    threadId: "t",
    outcome: "success",
    owner: null,
    routineId: null,
    at: 1,
    hasVisibleAssistantText: true,
  } as RunFinishedNotice;
  for (let duplicate = 0; duplicate < 2; duplicate += 1) {
    receive?.({ done: false, value: notice });
    for (let i = 0; i < 4; i += 1) await Promise.resolve();
  }
  for (const listener of listeners)
    expect(listener).toHaveBeenCalledExactlyOnceWith(notice);
  stops[0]?.();
  stops[1]?.();
  expect(signal?.aborted).toBe(false);
  stops[2]?.();
  expect(signal?.aborted).toBe(true);
});
