import { expect, it, vi } from "vitest";

import { createReadinessQueue } from "./readiness-queue";
it("R5-T3/T40 retains notice order during delayed snapshots and retry", async () => {
  vi.useFakeTimers();
  try {
    const abort = new AbortController();
    const calls: number[] = [];
    let release!: () => void;
    const load = vi
      .fn()
      .mockRejectedValueOnce(new Error("snapshot unavailable"))
      .mockImplementation(
        () =>
          new Promise<void>((resolve) => {
            release = resolve;
          })
      );
    const queue = createReadinessQueue(load, abort.signal, 10);
    queue.run(() => calls.push(1));
    queue.run(() => calls.push(2));
    await vi.advanceTimersByTimeAsync(10);
    expect(calls).toEqual([]);
    release();
    await queue.loaded;
    queue.run(() => calls.push(3));
    expect(calls).toEqual([1, 2, 3]);
    abort.abort();
    queue.run(() => calls.push(4));
    expect(calls).toEqual([1, 2, 3]);
  } finally {
    vi.useRealTimers();
  }
});
it("R5-T40 disposal discards delayed attention before delivery", async () => {
  const abort = new AbortController();
  let release!: () => void;
  const queue = createReadinessQueue(
    () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    abort.signal
  );
  const send = vi.fn();
  queue.run(send);
  abort.abort();
  release();
  await queue.loaded;
  expect(send).not.toHaveBeenCalled();
});
