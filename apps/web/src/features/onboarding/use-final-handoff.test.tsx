import { act, fireEvent, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import { useFinalHandoff } from "./use-final-handoff";

afterEach(() => vi.useRealTimers());
it("waits for readiness, then hands off exactly once at two seconds", () => {
  vi.useFakeTimers();
  const complete = vi.fn();
  const { rerender } = renderHook(
    ({ ready }) => useFinalHandoff(ready, complete),
    { initialProps: { ready: false } }
  );
  act(() => vi.advanceTimersByTime(5000));
  expect(complete).not.toHaveBeenCalled();
  rerender({ ready: true });
  act(() => vi.advanceTimersByTime(1999));
  expect(complete).not.toHaveBeenCalled();
  act(() => vi.advanceTimersByTime(1));
  expect(complete).toHaveBeenCalledTimes(1);
  rerender({ ready: true });
  act(() => vi.advanceTimersByTime(10000));
  expect(complete).toHaveBeenCalledTimes(1);
});
it.each(["pointer", "keyboard", "unmount", "dialog"])(
  "cancels automatic handoff for %s",
  (reason) => {
    vi.useFakeTimers();
    const complete = vi.fn();
    const { unmount } = renderHook(() => useFinalHandoff(true, complete));
    let dialog: HTMLElement | undefined;
    if (reason === "pointer") fireEvent.pointerDown(document);
    if (reason === "keyboard") fireEvent.keyDown(document, { key: "Escape" });
    if (reason === "unmount") unmount();
    if (reason === "dialog") {
      dialog = document.createElement("div");
      dialog.setAttribute("role", "dialog");
      document.body.append(dialog);
    }
    act(() => vi.advanceTimersByTime(3000));
    expect(complete).not.toHaveBeenCalled();
    dialog?.remove();
    act(() => vi.advanceTimersByTime(3000));
    expect(complete).not.toHaveBeenCalled();
  }
);
