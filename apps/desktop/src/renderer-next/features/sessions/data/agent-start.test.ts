import { afterEach, expect, it, vi } from "vitest";

import type { SessionRow } from "#shared/contract/rows";

import { agentLifecycle } from "./agent-start";
const row = {
  id: "s",
  workspaceId: "w",
  status: "stopped",
  conversationId: "c",
  model: "selected",
  mode: "AUTO",
} as SessionRow;
afterEach(() => vi.useRealTimers());
it("R4-T8 backs off and cancels retries on stop", async () => {
  vi.useFakeTimers();
  const start = vi.fn().mockRejectedValue(new Error("network"));
  const report = vi.fn();
  const lifecycle = agentLifecycle({ agent: { start } } as never, report);
  lifecycle.observe(row, true, null);
  await vi.advanceTimersByTimeAsync(500);
  expect(start).toHaveBeenCalledTimes(2);
  expect(start).toHaveBeenCalledWith({ workspaceId: "w", sessionId: "s" });
  lifecycle.stop();
  await vi.advanceTimersByTimeAsync(10000);
  expect(start).toHaveBeenCalledTimes(2);
  lifecycle.dispose();
});
it("R4-T8 restores a saved conversation once per ready incarnation", async () => {
  const switchConversation = vi.fn(async () => {});
  const lifecycle = agentLifecycle(
    {
      agent: {
        start: vi.fn(async () => ({ success: true })),
        switchConversation,
      },
    } as never,
    vi.fn()
  );
  const running = { ...row, status: "running" as const };
  lifecycle.observe(running, true, "inc-1");
  lifecycle.observe(running, true, "inc-1");
  await Promise.resolve();
  expect(switchConversation).toHaveBeenCalledTimes(1);
  lifecycle.observe(running, true, "inc-2");
  expect(switchConversation).toHaveBeenCalledTimes(2);
  lifecycle.dispose();
});
it("R4-T8 does not retry a missing checkout", async () => {
  vi.useFakeTimers();
  const start = vi.fn().mockRejectedValue({
    code: "PRECONDITION_FAILED",
    data: { reason: "workspace-missing" },
  });
  const lifecycle = agentLifecycle({ agent: { start } } as never, vi.fn());
  lifecycle.observe(row, true, null);
  await vi.advanceTimersByTimeAsync(10000);
  expect(start).toHaveBeenCalledTimes(1);
  lifecycle.dispose();
});
