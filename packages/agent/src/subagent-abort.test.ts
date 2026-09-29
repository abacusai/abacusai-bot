/**
 * The signal is the run's, not the tool call's.
 *
 * pi builds one AbortController per run and threads it through every tool it
 * invokes, so a listener added and never removed lives as long as the run:
 * one per sub-agent call, each holding its delegation's closure alive.
 */
import { getEventListeners } from "node:events";

import { describe, expect, it, vi } from "vitest";

import { whenAborted } from "./subagent-abort.js";

describe("waiting on a run's abort signal", () => {
  it("leaves nothing behind once each wait is disposed", () => {
    const controller = new AbortController();

    for (let call = 0; call < 20; call += 1)
      whenAborted(controller.signal, () => {}).dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("adds exactly one listener while a wait is outstanding", () => {
    const controller = new AbortController();
    const first = whenAborted(controller.signal, () => {});
    const second = whenAborted(controller.signal, () => {});

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(2);

    first.dispose();
    second.dispose();

    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  it("still resolves and reports when the signal aborts", async () => {
    const controller = new AbortController();
    const onAbort = vi.fn();
    const { aborted, dispose } = whenAborted(controller.signal, onAbort);

    controller.abort();
    await aborted;

    expect(onAbort).toHaveBeenCalledTimes(1);
    dispose();
  });

  it("resolves at once when the signal has already aborted", async () => {
    const controller = new AbortController();

    controller.abort();

    const onAbort = vi.fn();
    const { aborted, dispose } = whenAborted(controller.signal, onAbort);

    await aborted;

    expect(onAbort).toHaveBeenCalledTimes(1);
    // Nothing was ever attached, so disposing is a no-op rather than an error.
    expect(() => dispose()).not.toThrow();
  });

  it("is inert, and safely disposable, with no signal at all", () => {
    const onAbort = vi.fn();
    const { dispose } = whenAborted(undefined, onAbort);

    expect(() => dispose()).not.toThrow();
    expect(onAbort).not.toHaveBeenCalled();
  });
});
