import { withEventMeta } from "@orpc/client";
import { expect, it, vi } from "vitest";

import type { Transport } from "#next/data/transport";
import type { RunFinishedNotice } from "#shared/contract";

import { runFinishedFeed, subscribeRunFinished } from "./run-finished";
it("shares one resumed stream and advances its cursor only after buffered delivery settles", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const ready = new Promise<void>((resolve) => {
    release = resolve;
  });
  const notice = withEventMeta(
    {
      threadId: "s",
      runId: "r",
      outcome: "success",
      hasVisibleAssistantText: true,
      owner: null,
      routineId: null,
      at: 1,
    },
    { id: "7" }
  );
  const open = vi.fn(async function* (_input: { lastEventId?: string }) {
    yield notice;
    throw new Error("reopen");
  });
  const transport = {
    state: "open",
    client: { ai: { runFinished: open } },
  } as never;
  const one = vi.fn(async () => {
    await ready;
  });
  const two = vi.fn();
  const stopOne = subscribeRunFinished(transport, one);
  const stopTwo = subscribeRunFinished(transport, two);
  await vi.advanceTimersByTimeAsync(1000);
  expect(open).toHaveBeenCalledTimes(2);
  expect(open.mock.calls[1]![0]).toEqual({});
  release();
  await vi.advanceTimersByTimeAsync(1000);
  expect(open.mock.calls[2]![0]).toEqual({ lastEventId: "7" });
  expect(one).toHaveBeenCalledTimes(1);
  expect(two).toHaveBeenCalledTimes(1);
  stopOne();
  stopTwo();
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
});

it("keeps the settled resume cursor and dedupe history when consumers resubscribe", async () => {
  vi.useFakeTimers();
  const notice = withEventMeta(
    {
      threadId: "s",
      runId: "r",
      outcome: "success",
      hasVisibleAssistantText: true,
      owner: null,
      routineId: null,
      at: 1,
    },
    { id: "9" }
  );
  const open = vi.fn(async function* (_input: { lastEventId?: string }) {
    yield notice;
  });
  const transport = {
    state: "open",
    client: { ai: { runFinished: open } },
  } as never;
  const listeners = [vi.fn(), vi.fn(async () => {}), vi.fn()];
  const stops = listeners.map((fn) => subscribeRunFinished(transport, fn));
  await vi.advanceTimersByTimeAsync(0);
  expect(open).toHaveBeenCalledOnce();
  for (const fn of listeners) expect(fn).toHaveBeenCalledOnce();
  for (const stop of stops) stop();
  const resumed = vi.fn();
  const stop = runFinishedFeed(transport).subscribe(resumed);
  await vi.advanceTimersByTimeAsync(0);
  expect(open.mock.calls[1]![0]).toEqual({ lastEventId: "9" });
  expect(resumed).not.toHaveBeenCalled();
  stop();
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
});

it("R6-T15 one iterator feeds all four consumers, dedupes and closes after the last leaves", async () => {
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
  const listeners = [vi.fn(), vi.fn(), vi.fn(), vi.fn()];
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
  expect(signal?.aborted).toBe(false);
  stops[3]?.();
  expect(signal?.aborted).toBe(true);
});

it("isolates failed consumers and resumes after every consumer has settled", async () => {
  vi.useFakeTimers();
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const notice = withEventMeta(
    {
      threadId: "s",
      runId: "failed-consumer",
      outcome: "success",
      hasVisibleAssistantText: true,
      owner: null,
      routineId: null,
      at: 1,
    },
    { id: "11" }
  );
  const open = vi.fn(async function* (_input: { lastEventId?: string }) {
    yield notice;
  });
  const transport = {
    state: "open",
    client: { ai: { runFinished: open } },
  } as never;
  const receive = vi.fn();
  const stops = [
    subscribeRunFinished(transport, () => {
      throw new Error("sync consumer");
    }),
    subscribeRunFinished(transport, async () => {
      throw new Error("async consumer");
    }),
    runFinishedFeed(transport).subscribe(receive),
  ];
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(receive).toHaveBeenCalledExactlyOnceWith(notice);
    expect(warning).toHaveBeenCalledTimes(2);
    for (const stop of stops) stop();
    const stop = runFinishedFeed(transport).subscribe(vi.fn());
    await vi.advanceTimersByTimeAsync(0);
    expect(open.mock.calls[1]![0]).toEqual({ lastEventId: "11" });
    stop();
    await vi.advanceTimersByTimeAsync(1000);
  } finally {
    for (const stop of stops) stop();
    warning.mockRestore();
    vi.useRealTimers();
  }
});
