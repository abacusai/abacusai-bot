/**
 * The native-surface occlusion watcher (spec 01 §7.6). Publishes the rects of
 * every portaled overlay that could cover a native view (the browser view,
 * phase 4) or the title bar, from insertion until removal, including while it
 * animates out (`data-ending-style`). Rects stay current: a ResizeObserver per
 * candidate, window resize and capture-phase scroll, and a frame loop while
 * anything is starting, ending or animating. Publishes are deduplicated.
 */
import { OCCLUDER_SELECTOR } from "#renderer/lib/window-chrome/overlay-slots";

import type { OcclusionRect } from "./shell-store";

export interface OcclusionWatcherDeps {
  root?: HTMLElement;
  publish(rects: OcclusionRect[]): void;
  requestFrame?: (callback: () => void) => number;
  cancelFrame?: (handle: number) => void;
}

const isRendered = (element: Element): boolean => {
  const check = (
    element as Element & {
      checkVisibility?: (options?: {
        opacityProperty?: boolean;
        visibilityProperty?: boolean;
      }) => boolean;
    }
  ).checkVisibility;
  return (
    check == null ||
    check.call(element, { opacityProperty: false, visibilityProperty: true })
  );
};

const isAnimating = (element: Element): boolean => {
  if (
    element.hasAttribute("data-starting-style") ||
    element.hasAttribute("data-ending-style")
  )
    return true;
  const animations =
    typeof element.getAnimations === "function"
      ? element.getAnimations({ subtree: true })
      : [];
  return animations.some((animation) => animation.playState === "running");
};

export const createOcclusionWatcher = (
  deps: OcclusionWatcherDeps
): { measure(): void; dispose(): void } => {
  const root = deps.root ?? document.body;
  const requestFrame = deps.requestFrame ?? requestAnimationFrame;
  const cancelFrame = deps.cancelFrame ?? cancelAnimationFrame;
  const observers = new Map<Element, ResizeObserver>();
  let lastKey = "";
  let frame: number | null = null;
  let disposed = false;

  const measure = (): void => {
    if (disposed) return;
    const rects: OcclusionRect[] = [];
    let animating = false;
    for (const element of observers.keys()) {
      if (isAnimating(element)) animating = true;
      if (!isRendered(element)) continue;
      const box = element.getBoundingClientRect();
      if (box.width <= 0 || box.height <= 0) continue;
      rects.push({
        x: Math.round(box.x),
        y: Math.round(box.y),
        width: Math.round(box.width),
        height: Math.round(box.height),
      });
    }
    const key = JSON.stringify(rects);
    if (key !== lastKey) {
      lastKey = key;
      deps.publish(rects);
    }
    if (animating && frame === null) {
      frame = requestFrame(() => {
        frame = null;
        measure();
      });
    }
  };

  const sync = (): void => {
    const present = new Set(root.querySelectorAll(OCCLUDER_SELECTOR));
    for (const [element, observer] of observers) {
      if (present.has(element)) continue;
      observer.disconnect();
      observers.delete(element);
    }
    for (const element of present) {
      if (observers.has(element)) continue;
      const observer = new ResizeObserver(() => measure());
      observer.observe(element);
      observers.set(element, observer);
    }
    measure();
  };

  /**
   * Re-query only when overlays may have come or gone: a childList record
   * that adds or removes an occluder (or a subtree holding one). An
   * attribute change re-measures only when it is on a tracked candidate,
   * inside one or on an ancestor of one; the shell's own per-frame style and class flips (sidebar
   * spring, scrim) cost nothing (Claude impl r1 #14).
   */
  const holdsOccluder = (node: Node): boolean =>
    node instanceof Element &&
    (node.matches(OCCLUDER_SELECTOR) ||
      node.querySelector(OCCLUDER_SELECTOR) != null);
  const removesTracked = (node: Node): boolean => {
    for (const element of observers.keys())
      if (node === element || node.contains(element)) return true;
    return false;
  };
  const containsTracked = (node: Node): boolean => {
    for (const element of observers.keys())
      if (node !== element && node.contains(element)) return true;
    return false;
  };
  const onMutations = (records: MutationRecord[]): void => {
    let resync = false;
    let remeasure = false;
    for (const record of records) {
      if (record.type === "childList") {
        for (const node of record.addedNodes)
          if (holdsOccluder(node)) resync = true;
        for (const node of record.removedNodes)
          if (removesTracked(node)) resync = true;
        continue;
      }
      if (remeasure) continue;
      const target = record.target as Element;
      const candidate = target.closest?.(OCCLUDER_SELECTOR);
      if (candidate != null && observers.has(candidate)) remeasure = true;
      // An attribute that turns an element into a candidate (a slot set late).
      else if (target.matches?.(OCCLUDER_SELECTOR)) resync = true;
      // An ancestor of a tracked overlay: a positioner wrapper moves its popup
      // through an inline transform without resizing it (Codex impl r2 #3).
      else if (containsTracked(target)) remeasure = true;
    }
    if (resync) sync();
    else if (remeasure) measure();
  };
  const mutations = new MutationObserver(onMutations);
  mutations.observe(root, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: [
      "data-slot",
      "data-open",
      "data-starting-style",
      "data-ending-style",
      "style",
      "hidden",
      "class",
    ],
  });
  const onViewportChange = (): void => measure();
  window.addEventListener("resize", onViewportChange);
  window.addEventListener("scroll", onViewportChange, true);
  sync();

  return {
    measure,
    dispose() {
      disposed = true;
      mutations.disconnect();
      for (const observer of observers.values()) observer.disconnect();
      observers.clear();
      window.removeEventListener("resize", onViewportChange);
      window.removeEventListener("scroll", onViewportChange, true);
      if (frame !== null) cancelFrame(frame);
    },
  };
};
