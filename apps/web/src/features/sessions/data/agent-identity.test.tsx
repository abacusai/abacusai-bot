import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import type { SessionRow } from "@abacus-ai/contract/contract/rows";

import { useAgentLifecycle } from "./agent-start";
it("editing A → editing B warms B and disposes A's pending retries", async () => {
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
  expect(start).not.toHaveBeenCalled();
  const composer = document.createElement("textarea");
  document.body.append(composer);
  act(() =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "a", bubbles: true })
    )
  );
  hook.rerender({ row: { ...row, id: "B" } });
  const b = hook.result.current;
  act(() => b.observe({ ...row, id: "B" }, true, null));
  expect(start.mock.calls.map(([input]) => input.sessionId)).toEqual(["A"]);
  act(() =>
    composer.dispatchEvent(
      new KeyboardEvent("keydown", { key: "b", bubbles: true })
    )
  );
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
  composer.remove();
  vi.useRealTimers();
});
