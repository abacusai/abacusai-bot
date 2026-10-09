import { afterEach, expect, it, vi } from "vitest";

import type { Transport } from "#renderer/data/transport";

import { confirmFreePoolModel, creditActionsFor } from "./actions";

afterEach(() => vi.useRealTimers());
const scope = { workspaceId: "workspace", sessionId: "bot-session" };
it.each([
  ["pro", 1, true],
  ["basic", 1, true],
  ["go", 1, true],
  ["max", 1, true],
  ["pro", 4, false],
  ["enterprise", 1, false],
  ["team", 1, false],
  ["free", 1, false],
  ["unknown", 1, false],
])(
  "top-up eligibility uses actual %s account with %s members",
  async (tier, members, eligible) => {
    const transport = {
      client: {
        account: {
          abacus: async () => ({
            subscription_tier: tier,
            org_user_count: members,
          }),
        },
      },
    } as unknown as Transport;
    expect(await creditActionsFor(transport).canTopUpCredits!()).toBe(eligible);
  }
);
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
