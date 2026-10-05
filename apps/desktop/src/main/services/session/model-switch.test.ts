/**
 * `ModelSwitchWaiters` (spec 04 §26.4 d): the agent handles `set_model`
 * commands concurrently and a refusal names no model, so each session's
 * switches go out one at a time and an answer settles only the outstanding
 * one, and only when it names the requested model.
 */
import { describe, expect, it, vi } from "vitest";

import type { DesktopEvent } from "#shared/agent-types";

import { ModelSwitchWaiters, ModelUnavailableError } from "./model-switch";

const changed = (model: string): DesktopEvent =>
  ({ type: "event", event: { type: "model_changed", model } }) as never;
const refused = (message: string): DesktopEvent =>
  ({
    type: "event",
    event: { type: "error", error: { message, code: "model_unavailable" } },
  }) as never;

const settledState = async (promise: Promise<void>) => {
  let state = "pending";
  promise.then(
    () => (state = "resolved"),
    () => (state = "rejected")
  );
  await Promise.resolve();
  await Promise.resolve();
  return state;
};

describe("ModelSwitchWaiters", () => {
  it("concurrent switches to an available A and an unavailable B: A resolves, B is refused", async () => {
    const waiters = new ModelSwitchWaiters();
    const sent: string[] = [];
    const a = waiters.wait("s", "prov/a", () => (sent.push("prov/a"), true));
    const b = waiters.wait("s", "prov/b", () => (sent.push("prov/b"), true));
    // B is not written while A is outstanding.
    expect(sent).toEqual(["prov/a"]);

    waiters.feed("s", changed("prov/a"));
    await expect(a).resolves.toBeUndefined();
    expect(sent).toEqual(["prov/a", "prov/b"]);
    expect(await settledState(b)).toBe("pending");

    waiters.feed("s", refused("B has no key."));
    await expect(b).rejects.toBeInstanceOf(ModelUnavailableError);
    await expect(b).rejects.toThrow("B has no key.");
    expect(waiters.pending).toBe(0);
  });

  it("a model_changed that names another model (an OpenLLM rotation) settles nothing", async () => {
    const waiters = new ModelSwitchWaiters();
    const b = waiters.wait("s", "prov/b", () => true);
    waiters.feed("s", changed("openllm/auto"));
    expect(await settledState(b)).toBe("pending");
    waiters.feed("s", changed("prov/b"));
    await expect(b).resolves.toBeUndefined();
  });

  it("a bare requested id matches the agent's qualified answer", async () => {
    const waiters = new ModelSwitchWaiters();
    const b = waiters.wait("s", "model-b", () => true);
    waiters.feed("s", changed("prov/model-b"));
    await expect(b).resolves.toBeUndefined();
  });

  it("a fire-and-forget switch (legacy, bot re-pin) keeps its own refusal; the checked one after it waits its turn", async () => {
    const waiters = new ModelSwitchWaiters();
    const sent: string[] = [];
    waiters.post("s", "prov/gone", () => (sent.push("prov/gone"), true));
    const checked = waiters.wait(
      "s",
      "prov/ok",
      () => (sent.push("prov/ok"), true)
    );
    expect(sent).toEqual(["prov/gone"]);
    waiters.feed("s", refused("gone"));
    expect(await settledState(checked)).toBe("pending");
    expect(sent).toEqual(["prov/gone", "prov/ok"]);
    waiters.feed("s", changed("prov/ok"));
    await expect(checked).resolves.toBeUndefined();
  });

  it("a caller deadline retains the command until its late refusal; sessions are independent", async () => {
    vi.useFakeTimers();
    try {
      const waiters = new ModelSwitchWaiters();
      const sent: string[] = [];
      const first = waiters.wait("s", "prov/a", () => true, 1_000);
      const second = waiters.wait(
        "s",
        "prov/b",
        () => (sent.push("s:b"), true),
        1_000
      );
      const other = waiters.wait(
        "t",
        "prov/c",
        () => (sent.push("t:c"), true),
        1_000
      );
      expect(sent).toEqual(["t:c"]);
      vi.advanceTimersByTime(1_000);
      await expect(first).resolves.toBeUndefined();
      await expect(other).resolves.toBeUndefined();
      expect(sent).toEqual(["t:c"]);
      expect(await settledState(second)).toBe("pending");
      waiters.feed("s", refused("A's late refusal"));
      expect(sent).toEqual(["t:c", "s:b"]);
      expect(await settledState(second)).toBe("pending");
      waiters.feed("s", changed("prov/b"));
      await expect(second).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("process invalidation releases timed-out and queued callers without sending stale commands", async () => {
    vi.useFakeTimers();
    try {
      const waiters = new ModelSwitchWaiters();
      const sendB = vi.fn(() => true);
      const a = waiters.wait("s", "a", () => true, 100);
      const b = waiters.wait("s", "b", sendB, 100);
      await vi.advanceTimersByTimeAsync(100);
      await expect(a).resolves.toBeUndefined();
      waiters.invalidate("s");
      await expect(b).resolves.toBeUndefined();
      expect(sendB).not.toHaveBeenCalled();
      expect(waiters.pending).toBe(0);
      const c = waiters.wait("s", "c", () => false);
      await expect(c).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("post written at once throws what send throws, as the legacy call did", () => {
    const waiters = new ModelSwitchWaiters();
    expect(() =>
      waiters.post("s", "prov/a", () => {
        throw new Error("no process");
      })
    ).toThrow("no process");
    expect(waiters.pending).toBe(0);
  });
});
