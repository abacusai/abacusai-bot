import type { DockviewApi } from "dockview-react";
import { expect, it, vi } from "vitest";

import { enhanceDockSplitters } from "./splitters";

it("resizes with arrow keys and resets with Home or double click through Dockview", () => {
  const container = document.createElement("div");
  container.innerHTML =
    '<div class="dv-horizontal"><div><div class="dv-sash"></div></div></div>';
  const sash = container.querySelector<HTMLElement>(".dv-sash")!;
  sash.getBoundingClientRect = () => new DOMRect(396, 0, 8, 600);
  const left = document.createElement("div");
  const right = document.createElement("div");
  left.getBoundingClientRect = () => new DOMRect(0, 0, 400, 600);
  right.getBoundingClientRect = () => new DOMRect(400, 0, 600, 600);
  const setSize = vi.fn();
  const dispose = enhanceDockSplitters(container, {
    groups: [
      { element: left, api: { setSize } },
      { element: right, api: { setSize: vi.fn() } },
    ],
  } as unknown as DockviewApi);
  expect(sash.tabIndex).toBe(0);
  expect(sash.getAttribute("aria-orientation")).toBe("vertical");
  sash.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
  );
  expect(setSize).toHaveBeenLastCalledWith({ width: 416 });
  sash.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: "ArrowLeft",
      shiftKey: true,
      bubbles: true,
    })
  );
  expect(setSize).toHaveBeenLastCalledWith({ width: 336 });
  sash.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true })
  );
  expect(setSize).toHaveBeenLastCalledWith({ width: 500 });
  sash.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));
  expect(setSize).toHaveBeenLastCalledWith({ width: 500 });
  dispose();
  setSize.mockClear();
  sash.dispatchEvent(
    new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true })
  );
  expect(setSize).not.toHaveBeenCalled();
});
