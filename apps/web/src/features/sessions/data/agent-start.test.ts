import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import { afterEach, expect, it, vi } from "vitest";

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
it("Retry repeats failed restoration, and late failures cannot report after stop", async () => {
  const report = vi.fn();
  const switchConversation = vi
    .fn()
    .mockRejectedValueOnce(new Error("restore failed"))
    .mockResolvedValue(undefined);
  const start = vi.fn().mockResolvedValue({ success: true });
  const lifecycle = agentLifecycle(
    { agent: { start, switchConversation } } as never,
    report
  );
  const running = { ...row, status: "running" as const };
  lifecycle.observe(running, true, "inc-1");
  await vi.waitFor(() =>
    expect(report).toHaveBeenCalledWith(expect.any(Error))
  );
  lifecycle.retry(running);
  await vi.waitFor(() => expect(switchConversation).toHaveBeenCalledTimes(2));
  lifecycle.observe(running, true, "inc-1");
  expect(switchConversation).toHaveBeenCalledTimes(2);
  let reject!: (error: unknown) => void;
  switchConversation.mockImplementationOnce(
    () =>
      new Promise((_, no) => {
        reject = no;
      })
  );
  lifecycle.observe(running, true, "inc-2");
  lifecycle.stop();
  report.mockClear();
  reject(new Error("stale"));
  await Promise.resolve();
  await Promise.resolve();
  expect(report).not.toHaveBeenCalled();
  lifecycle.dispose();
});
it("joined start readiness gates restoration even when the ready relay arrives first", async () => {
  let ready!: (result: unknown) => void;
  const start = vi.fn(
    () =>
      new Promise((resolve) => {
        ready = resolve;
      })
  );
  const switchConversation = vi.fn(async () => {});
  const lifecycle = agentLifecycle(
    { agent: { start, switchConversation } } as never,
    vi.fn()
  );
  lifecycle.observe(row, true, null);
  lifecycle.observe({ ...row, status: "running" }, true, "ready-inc");
  expect(switchConversation).not.toHaveBeenCalled();
  ready({ success: true });
  await vi.waitFor(() => expect(switchConversation).toHaveBeenCalledOnce());
  lifecycle.dispose();
});

it("reading an idle session does not spawn; explicit intent still starts it", async () => {
  const start = vi.fn().mockResolvedValue({ success: true });
  const lifecycle = agentLifecycle(
    { agent: { start } } as never,
    vi.fn(),
    "w:s",
    false
  );
  lifecycle.observe(row, true, null);
  await Promise.resolve();
  expect(start).not.toHaveBeenCalled();
  lifecycle.retry(row);
  await Promise.resolve();
  expect(start).toHaveBeenCalledOnce();
  lifecycle.dispose();
});
