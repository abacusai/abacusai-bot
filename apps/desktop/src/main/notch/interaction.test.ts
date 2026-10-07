import type { BaseWindow } from "electron";
import { expect, it, vi } from "vitest";

import { setFocused, setInteractive } from "./interaction";

it("R6-T26 passive/interactive/focused native transitions", () => {
  const win = {
    setIgnoreMouseEvents: vi.fn(),
    setFocusable: vi.fn(),
    focus: vi.fn(),
    blur: vi.fn(),
  };
  setInteractive(win as unknown as BaseWindow, true);
  expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, {
    forward: true,
  });
  expect(win.focus).not.toHaveBeenCalled();
  setFocused(win as unknown as BaseWindow, true);
  expect(win.setFocusable).toHaveBeenLastCalledWith(true);
  expect(win.focus).toHaveBeenCalledOnce();
  setInteractive(win as unknown as BaseWindow, false);
  expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(false, {
    forward: true,
  });
  expect(win.blur).not.toHaveBeenCalled();
  setFocused(win as unknown as BaseWindow, false);
  setInteractive(win as unknown as BaseWindow, false);
  expect(win.setIgnoreMouseEvents).toHaveBeenLastCalledWith(true, {
    forward: true,
  });
  expect(win.setFocusable).toHaveBeenLastCalledWith(false);
  expect(win.blur).toHaveBeenCalledOnce();
});
