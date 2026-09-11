import { waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  describeNativeSurfaceOcclusion,
  hasNativeSurfaceOccluder,
  isNativeSurfaceHostVisible,
  subscribeNativeSurfaceEnvironment,
} from "./native-surface-occlusion";

const visibleBounds = {
  x: 10,
  y: 10,
  top: 10,
  left: 10,
  right: 410,
  bottom: 310,
  width: 400,
  height: 300,
  toJSON: () => ({}),
};

afterEach(() => {
  document.body.replaceChildren();
});

describe("native surface occlusion", () => {
  it("detects app overlays and hidden browser hosts", async () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = vi.fn(() => visibleBounds);
    document.body.append(host);

    expect(isNativeSurfaceHostVisible(host)).toBe(true);
    expect(hasNativeSurfaceOccluder()).toBe(false);

    const changed = vi.fn();
    const unsubscribe = subscribeNativeSurfaceEnvironment(changed);
    const menu = document.createElement("div");
    menu.setAttribute("role", "menu");
    menu.getBoundingClientRect = vi.fn(() => visibleBounds);
    document.body.append(menu);

    await waitFor(() => expect(changed).toHaveBeenCalledTimes(2));
    expect(hasNativeSurfaceOccluder()).toBe(true);
    expect(hasNativeSurfaceOccluder(host)).toBe(true);

    host.hidden = true;
    expect(isNativeSurfaceHostVisible(host)).toBe(false);
    unsubscribe();
  });

  it("ignores an overlay that does not cover the host", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = vi.fn(() => visibleBounds);
    document.body.append(host);
    const listbox = document.createElement("div");
    listbox.setAttribute("role", "listbox");
    listbox.getBoundingClientRect = vi.fn(() => ({
      ...visibleBounds,
      x: 600,
      left: 600,
      right: 800,
      y: 500,
      top: 500,
      bottom: 600,
    }));
    document.body.append(listbox);

    expect(hasNativeSurfaceOccluder()).toBe(true);
    expect(hasNativeSurfaceOccluder(host)).toBe(false);
    expect(describeNativeSurfaceOcclusion(host)).toBe("none");
  });

  it("keeps the host visible under a stale aria-hidden ancestor", () => {
    const root = document.createElement("div");
    root.setAttribute("aria-hidden", "true");
    const host = document.createElement("div");
    host.getBoundingClientRect = vi.fn(() => visibleBounds);
    root.append(host);
    document.body.append(root);

    expect(isNativeSurfaceHostVisible(host)).toBe(true);
  });

  it("names what is in the way", () => {
    const host = document.createElement("div");
    host.getBoundingClientRect = vi.fn(() => visibleBounds);
    document.body.append(host);
    const overlay = document.createElement("div");
    overlay.setAttribute("data-slot", "dialog-overlay");
    overlay.getBoundingClientRect = vi.fn(() => visibleBounds);
    document.body.append(overlay);

    expect(describeNativeSurfaceOcclusion(host)).toBe(
      "overlay div dialog-overlay"
    );
  });
});
