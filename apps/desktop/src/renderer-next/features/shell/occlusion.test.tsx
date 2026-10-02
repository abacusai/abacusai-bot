/** R1-T10: the occlusion watcher's candidates, rects and re-measuring. */
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { Toaster, toast } from "#next/ui/toast";

import { createOcclusionWatcher } from "./occlusion";
import type { OcclusionRect } from "./shell-store";

const rect = (x: number, y: number, width: number, height: number) =>
  ({
    x,
    y,
    width,
    height,
    top: y,
    left: x,
    right: x + width,
    bottom: y + height,
    toJSON: () => ({}),
  }) as DOMRect;

const boxes = new WeakMap<Element, DOMRect>();
const original = HTMLElement.prototype.getBoundingClientRect;
beforeEach(() => {
  HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    return boxes.get(this) ?? rect(0, 0, 100, 40);
  };
});

const added: HTMLElement[] = [];
const add = (slot: string, box = rect(10, 20, 100, 40)): HTMLElement => {
  const element = document.createElement("div");
  element.dataset.slot = slot;
  boxes.set(element, box);
  document.body.append(element);
  added.push(element);
  return element;
};

const flush = () =>
  act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

let dispose: (() => void) | null = null;
afterEach(() => {
  dispose?.();
  dispose = null;
  for (const element of added.splice(0)) element.remove();
});

const watch = (
  overrides: Partial<Parameters<typeof createOcclusionWatcher>[0]> = {}
) => {
  const published: OcclusionRect[][] = [];
  const watcher = createOcclusionWatcher({
    publish: (rects) => published.push(rects),
    ...overrides,
  });
  dispose = watcher.dispose;
  return { published, watcher, last: () => published.at(-1) ?? [] };
};

describe("createOcclusionWatcher", () => {
  it("publishes nothing for an idle Toaster, then two rects for two toasts", async () => {
    render(<Toaster />);
    const { last } = watch();
    await flush();
    expect(last()).toEqual([]);
    const ids: string[] = [];
    await act(async () => {
      ids.push(toast.add({ title: "One" }), toast.add({ title: "Two" }));
    });
    await flush();
    expect(document.querySelectorAll('[data-slot="toast"]')).toHaveLength(2);
    expect(last()).toHaveLength(2);
    act(() => {
      for (const id of ids) toast.close(id);
    });
  });

  it("keeps occluding while an overlay animates out", async () => {
    const { last } = watch();
    const popover = add("popover-content");
    await flush();
    expect(last()).toHaveLength(1);
    popover.setAttribute("data-ending-style", "");
    await flush();
    expect(last()).toHaveLength(1);
    popover.remove();
    await flush();
    expect(last()).toEqual([]);
  });

  it("ignores zero-size and unrendered candidates and non-occluding slots", async () => {
    const { last } = watch();
    add("dialog-content", rect(0, 0, 0, 20));
    const hidden = add("popover-content");
    (
      hidden as HTMLElement & { checkVisibility: () => boolean }
    ).checkVisibility = () => false;
    add("message-scroller-content");
    await flush();
    expect(last()).toEqual([]);
  });

  it("re-measures on resize, scroll and ResizeObserver callbacks", async () => {
    const callbacks: Array<() => void> = [];
    const OriginalRO = globalThis.ResizeObserver;
    globalThis.ResizeObserver = class {
      constructor(callback: () => void) {
        callbacks.push(callback);
      }
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { last } = watch();
      const dialog = add("dialog-content", rect(0, 0, 100, 100));
      await flush();
      boxes.set(dialog, rect(0, 0, 200, 100));
      window.dispatchEvent(new Event("resize"));
      expect(last()[0]?.width).toBe(200);
      boxes.set(dialog, rect(0, 50, 200, 100));
      document.dispatchEvent(new Event("scroll"));
      expect(last()[0]?.y).toBe(50);
      boxes.set(dialog, rect(0, 50, 300, 100));
      for (const callback of callbacks) callback();
      expect(last()[0]?.width).toBe(300);
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("never re-queries the document for style or class flips outside the overlays", async () => {
    const { last } = watch();
    const dialog = add("dialog-content", rect(0, 0, 100, 100));
    await flush();
    const unrelated = add("sidebar-slot");
    await flush();
    const query = vi.spyOn(document.body, "querySelectorAll");
    for (let i = 0; i < 20; i += 1) {
      unrelated.style.width = `${i}px`;
      unrelated.className = `w-${i}`;
    }
    await flush();
    expect(query).not.toHaveBeenCalled();
    // A change on the candidate itself still re-measures, without a query.
    boxes.set(dialog, rect(0, 0, 150, 100));
    dialog.style.opacity = "0.5";
    await flush();
    expect(last()[0]?.width).toBe(150);
    expect(query).not.toHaveBeenCalled();
    // A new overlay is still picked up.
    add("popover-content");
    await flush();
    expect(query).toHaveBeenCalled();
    expect(last()).toHaveLength(2);
  });

  it("re-measures when an ancestor of a tracked overlay moves it without a resize or scroll (Codex impl r2 #3)", async () => {
    const OriginalRO = globalThis.ResizeObserver;
    // No ResizeObserver callback fires: the popup's size never changes.
    globalThis.ResizeObserver = class {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
    try {
      const { last } = watch();
      const positioner = document.createElement("div");
      positioner.dataset.slot = "popover-positioner";
      const popup = document.createElement("div");
      popup.dataset.slot = "popover-content";
      boxes.set(popup, rect(10, 20, 100, 40));
      positioner.append(popup);
      document.body.append(positioner);
      added.push(positioner);
      await flush();
      expect(last()).toEqual([{ x: 10, y: 20, width: 100, height: 40 }]);
      const query = vi.spyOn(document.body, "querySelectorAll");
      query.mockClear();
      // Base UI's positioner writes the new position as an inline transform.
      boxes.set(popup, rect(210, 120, 100, 40));
      positioner.style.transform = "translate(210px, 120px)";
      await flush();
      expect(last()).toEqual([{ x: 210, y: 120, width: 100, height: 40 }]);
      // A re-measure, not a re-query.
      expect(query).not.toHaveBeenCalled();
    } finally {
      globalThis.ResizeObserver = OriginalRO;
    }
  });

  it("runs a frame loop while animations run, and stops after", async () => {
    const frames: Array<() => void> = [];
    const requestFrame = vi.fn((callback: () => void) => {
      frames.push(callback);
      return frames.length;
    });
    const { last } = watch({ requestFrame, cancelFrame: () => undefined });
    const sheet = add("sheet-content", rect(0, 0, 50, 50));
    let running = true;
    sheet.getAnimations = () =>
      [
        { playState: running ? "running" : "finished" },
      ] as unknown as Animation[];
    await flush();
    expect(requestFrame).toHaveBeenCalled();
    boxes.set(sheet, rect(0, 0, 80, 50));
    frames.shift()!();
    expect(last()[0]?.width).toBe(80);
    running = false;
    const before = requestFrame.mock.calls.length;
    frames.shift()!();
    expect(requestFrame.mock.calls.length).toBe(before);
  });
});

afterEach(() => {
  HTMLElement.prototype.getBoundingClientRect = original;
});
