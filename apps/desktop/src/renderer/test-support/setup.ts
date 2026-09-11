/**
 * What a renderer test can assume exists beyond jsdom: `window.api` (the
 * preload bridge) stubbed to a shape that answers rather than throws, and the
 * browser APIs Radix and the resizable panels call on mount. A test that cares
 * what a call returns overrides that method.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

/** Unmount between tests so no DOM leaks into the next one. */
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

/** Records nothing and reports nothing: components only need it to exist. */
class ResizeObserverStub {
  observe(): void {
    return;
  }

  unobserve(): void {
    return;
  }

  disconnect(): void {
    return;
  }
}

if (!("ResizeObserver" in globalThis)) {
  globalThis.ResizeObserver =
    ResizeObserverStub as unknown as typeof ResizeObserver;
}

if (typeof window !== "undefined") {
  // Node can expose an unusable localStorage global when no backing file was
  // configured. jsdom then inherits `undefined` instead of creating its own.
  if (window.localStorage == null) {
    const values = new Map<string, string>();
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      value: {
        get length() {
          return values.size;
        },
        clear: () => values.clear(),
        getItem: (key: string) => values.get(key) ?? null,
        key: (index: number) => [...values.keys()][index] ?? null,
        removeItem: (key: string) => values.delete(key),
        setItem: (key: string, value: string) => values.set(key, String(value)),
      } satisfies Storage,
    });
  }

  if (window.matchMedia == null) {
    window.matchMedia = ((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as unknown as typeof window.matchMedia;
  }

  // Radix uses pointer capture and scrollIntoView, neither of which jsdom has.
  if (window.HTMLElement.prototype.hasPointerCapture == null) {
    window.HTMLElement.prototype.hasPointerCapture = () => false;
    window.HTMLElement.prototype.setPointerCapture = () => {};
    window.HTMLElement.prototype.releasePointerCapture = () => {};
  }
  if (window.HTMLElement.prototype.scrollIntoView == null) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
}
