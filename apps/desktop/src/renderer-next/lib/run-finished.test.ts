import { withEventMeta } from "@orpc/client";
import { expect, it, vi } from "vitest";

import { subscribeRunFinished } from "./run-finished";
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
