/** R1-T12: window-chrome §10 renderer cases, against renderer. */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import {
  installWindowControlsOverlay,
  setViewportWidth,
} from "#renderer/test-support/media";

import { readTitlebarArea, useTitlebarArea } from "./use-titlebar-area";

let uninstall: (() => void) | null = null;
afterEach(() => {
  uninstall?.();
  uninstall = null;
});

describe("useTitlebarArea", () => {
  it("reads the overlay's reservations", () => {
    setViewportWidth(1280);
    const overlay = installWindowControlsOverlay({
      x: 78,
      y: 0,
      width: 1064,
      height: 40,
    });
    uninstall = overlay.uninstall;
    const { result } = renderHook(() => useTitlebarArea(40));
    expect(result.current).toEqual({
      x: 78,
      end: 138,
      height: 40,
      overlayVisible: true,
    });
  });

  it("updates on geometrychange", () => {
    setViewportWidth(1280);
    const overlay = installWindowControlsOverlay({
      x: 78,
      y: 0,
      width: 1202,
      height: 40,
    });
    uninstall = overlay.uninstall;
    const { result } = renderHook(() => useTitlebarArea(40));
    expect(result.current.end).toBe(0);
    act(() => overlay.setRect({ x: 0, y: 0, width: 1142, height: 40 }));
    expect(result.current).toMatchObject({ x: 0, end: 138 });
  });

  it("falls back when the API is missing", () => {
    const { result } = renderHook(() => useTitlebarArea(32));
    expect(result.current).toEqual({
      x: 0,
      end: 0,
      height: 32,
      overlayVisible: false,
    });
  });

  it.each([40, 32])(
    "hidden overlay with a zero rect (fullscreen) keeps the %i px toolbar and no reservations",
    (toolbarHeight) => {
      const overlay = installWindowControlsOverlay({
        x: 0,
        y: 0,
        width: 0,
        height: 0,
        visible: false,
      });
      uninstall = overlay.uninstall;
      const { result } = renderHook(() => useTitlebarArea(toolbarHeight));
      expect(result.current).toEqual({
        x: 0,
        end: 0,
        height: toolbarHeight,
        overlayVisible: false,
      });
    }
  );

  it("never takes the height from a zero-height visible rect", () => {
    const area = readTitlebarArea(
      {
        visible: true,
        getTitlebarAreaRect: () =>
          ({ x: 0, y: 0, width: 800, height: 0 }) as DOMRect,
      } as never,
      40,
      800
    );
    expect(area).toEqual({ x: 0, end: 0, height: 40, overlayVisible: false });
  });
});
