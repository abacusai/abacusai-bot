import { act, renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";

import { useRowConnects, type RowConnectOutcome } from "./use-row-connects";

const pending = () => {
  let answer: (outcome: RowConnectOutcome) => void = () => {};
  const run = vi.fn(
    () =>
      new Promise<RowConnectOutcome>((resolve) => {
        answer = resolve;
      })
  );
  return { run, answer: (outcome: RowConnectOutcome) => answer(outcome) };
};
const settle = () => act(() => new Promise((resolve) => setTimeout(resolve)));

it.each([
  ["connected", { ok: true } as const, null, 1],
  [
    "cancelled on the host",
    { ok: false, cancelled: true, error: "x" } as const,
    null,
    0,
  ],
  ["failed", { ok: false, error: "timeout" } as const, "timeout", 0],
])("a row whose wait ended %s", async (_case, outcome, error, reads) => {
  const view = renderHook(() => useRowConnects());
  const wait = pending();
  const connected = vi.fn(async () => {});
  act(() => view.result.current.start("a", { run: wait.run, connected }));
  expect(wait.run).toHaveBeenCalledOnce();
  expect(view.result.current.waiting("a")).toBe(true);
  expect(view.result.current.waiting("b")).toBe(false);
  wait.answer(outcome);
  await settle();
  expect(view.result.current.waiting("a")).toBe(false);
  expect(view.result.current.error("a")).toBe(error);
  expect(connected).toHaveBeenCalledTimes(reads);
});

it("Cancel hands the row back at once and ignores the late answer", async () => {
  const view = renderHook(() => useRowConnects());
  const wait = pending();
  const cancel = vi.fn();
  const connected = vi.fn(async () => {});
  act(() =>
    view.result.current.start("a", { run: wait.run, cancel, connected })
  );
  act(() => view.result.current.cancel("a"));
  expect(cancel).toHaveBeenCalledOnce();
  expect(view.result.current.waiting("a")).toBe(false);
  wait.answer({ ok: true });
  await settle();
  expect(connected).not.toHaveBeenCalled();
  expect(view.result.current.error("a")).toBeNull();
});

it("a new start supersedes the row's earlier wait", async () => {
  const view = renderHook(() => useRowConnects());
  const first = pending();
  const second = pending();
  act(() => view.result.current.start("a", { run: first.run }));
  act(() => view.result.current.start("a", { run: second.run }));
  first.answer({ ok: false, error: "late" });
  await settle();
  expect(view.result.current.waiting("a")).toBe(true);
  expect(view.result.current.error("a")).toBeNull();
});

it("leaving the page lets go of every row still waiting", () => {
  const view = renderHook(() => useRowConnects());
  const leave = vi.fn();
  act(() => view.result.current.start("a", { run: pending().run, leave }));
  view.unmount();
  expect(leave).toHaveBeenCalledOnce();
});
