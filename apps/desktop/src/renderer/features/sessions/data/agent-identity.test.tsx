import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { SessionRow } from "#shared/contract/rows";

import { useAgentLifecycle } from "./agent-start";
it("stopped A → stopped B starts B and disposes A's pending retries", async () => {
  vi.useFakeTimers();
  const start = vi.fn().mockRejectedValue(new Error("offline"));
  const client = { agent: { start } } as never;
  const report = vi.fn();
  const row = { workspaceId: "w", id: "A", status: "stopped" } as SessionRow;
  const hook = renderHook(({ row }) => useAgentLifecycle(client, row, report), {
    initialProps: { row },
  });
  const a = hook.result.current;
  act(() => a.observe(row, true, null));
  hook.rerender({ row: { ...row, id: "B" } });
  const b = hook.result.current;
  act(() => b.observe({ ...row, id: "B" }, true, null));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(500);
  });
  expect(start.mock.calls.map(([input]) => input.sessionId)).toEqual([
    "A",
    "B",
    "B",
  ]);
  expect(b).not.toBe(a);
  hook.unmount();
  vi.useRealTimers();
});
