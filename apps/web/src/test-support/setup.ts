/**
 * What a renderer test can assume beyond jsdom (spec 01 §3.7): the jsdom
 * shims the old renderer's setup has (copied, not imported: this tree may not
 * reach the old one), a controllable `matchMedia`, no
 * `document.startViewTransition` (React then skips view transitions), and a
 * stub `navigator.windowControlsOverlay` factory.
 */
import { cleanup } from "@testing-library/react";
import { afterEach, vi } from "vitest";

import { resetMedia } from "./media";

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  resetMedia();
  document.documentElement.className = "";
  for (const name of document.documentElement.getAttributeNames())
    if (name !== "lang" && name !== "dir")
      document.documentElement.removeAttribute(name);
  document.documentElement.removeAttribute("style");
});

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

  if (window.HTMLElement.prototype.hasPointerCapture == null) {
    window.HTMLElement.prototype.hasPointerCapture = () => false;
    window.HTMLElement.prototype.setPointerCapture = () => {};
    window.HTMLElement.prototype.releasePointerCapture = () => {};
  }
  if (window.HTMLElement.prototype.scrollIntoView == null) {
    window.HTMLElement.prototype.scrollIntoView = () => {};
  }
  window.scrollTo = () => undefined;
  // index-next.html has one; axe checks it.
  document.title = "AbacusAI Bot";
  if (window.HTMLElement.prototype.getAnimations == null) {
    window.HTMLElement.prototype.getAnimations = () => [];
  }
  if (document.getAnimations == null) {
    document.getAnimations = () => [];
  }
  // jsdom has no view transitions; React then commits without one.
  delete (document as { startViewTransition?: unknown }).startViewTransition;
}
