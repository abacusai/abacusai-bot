import { describe, expect, it } from "vitest";

import {
  MACOS_TRAFFIC_LIGHT_POSITION,
  windowChromeMetrics,
} from "./window-chrome";

describe("window chrome geometry", () => {
  it("keeps the macOS traffic lights centered in the custom title bar", () => {
    const { titlebarHeight, contentStartInset } = windowChromeMetrics("darwin");

    expect(MACOS_TRAFFIC_LIGHT_POSITION).toEqual({ x: 16, y: 13 });
    expect(titlebarHeight).toBe(40);
    expect(contentStartInset).toBe(84);
  });

  it("matches the Windows overlay height", () => {
    expect(windowChromeMetrics("win32")).toEqual({
      titlebarHeight: 32,
      contentStartInset: 16,
    });
  });

  it("keeps native Linux chrome separate from the renderer bar", () => {
    expect(windowChromeMetrics("linux")).toEqual({
      titlebarHeight: 40,
      contentStartInset: 16,
    });
  });
});
