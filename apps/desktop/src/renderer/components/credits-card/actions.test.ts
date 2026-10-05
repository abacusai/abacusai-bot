import { afterEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { confirmFreePoolModel } from "./actions";

afterEach(() => vi.useRealTimers());
const scope = { workspaceId: "workspace", sessionId: "bot-session" };
it("waits for the confirmed live model before permitting a dead-turn replay", async () => {
  vi.useFakeTimers();
  const state = vi
    .fn()
    .mockResolvedValueOnce({ status: "running", model: "old/model" })
    .mockResolvedValue({ status: "running", model: "abacus/openllm" });
  const transport = { client: { agent: { state } } } as unknown as Transport;
  let confirmed = false;
  const pending = confirmFreePoolModel(transport, scope).then(() => {
    confirmed = true;
  });
  await vi.advanceTimersByTimeAsync(0);
  expect(confirmed).toBe(false);
  await vi.advanceTimersByTimeAsync(50);
  await pending;
  expect(confirmed).toBe(true);
  expect(state).toHaveBeenCalledWith(scope);
});
it("a refused model switch times out rather than replaying on the old model", async () => {
  vi.useFakeTimers();
  const state = vi
    .fn()
    .mockResolvedValue({ status: "running", model: "old/model" });
  const transport = { client: { agent: { state } } } as unknown as Transport;
  const pending = expect(
    confirmFreePoolModel(transport, scope)
  ).rejects.toThrow("did not confirm");
  await vi.advanceTimersByTimeAsync(5_000);
  await pending;
});
