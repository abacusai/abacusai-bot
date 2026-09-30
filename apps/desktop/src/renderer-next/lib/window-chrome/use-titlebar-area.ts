/**
 * The title bar's geometry for JS-side math only (spec 00-window-chrome §6
 * rule 5; spec 01 §7.4): the toast offset and the floating sidebar's top.
 * Layout itself uses the CSS variables. Native overlay geometry is valid only
 * while `visible`; otherwise (fullscreen, native frame, no API) reservations
 * are 0 and the height is the app's own toolbar height, never a zero rect's.
 */
import { useSyncExternalStore } from "react";

export interface TitlebarArea {
  /** Left reservation (macOS traffic lights), CSS px. */
  x: number;
  /** Right reservation (caption buttons), CSS px. */
  end: number;
  /** The app toolbar's height: density-driven, never the overlay rect's. */
  height: number;
  overlayVisible: boolean;
}

interface OverlayLike extends EventTarget {
  readonly visible: boolean;
  getTitlebarAreaRect(): DOMRect;
}

const overlay = (): OverlayLike | undefined =>
  (navigator as Navigator & { windowControlsOverlay?: OverlayLike })
    .windowControlsOverlay;

export const readTitlebarArea = (
  source: OverlayLike | undefined,
  toolbarHeight: number,
  innerWidth: number
): TitlebarArea => {
  if (source == null || !source.visible)
    return { x: 0, end: 0, height: toolbarHeight, overlayVisible: false };
  const rect = source.getTitlebarAreaRect();
  if (rect.width <= 0 || rect.height <= 0)
    return { x: 0, end: 0, height: toolbarHeight, overlayVisible: false };
  return {
    x: Math.max(0, rect.x),
    end: Math.max(0, innerWidth - (rect.x + rect.width)),
    height: toolbarHeight,
    overlayVisible: true,
  };
};

const subscribe = (onChange: () => void): (() => void) => {
  const source = overlay();
  source?.addEventListener("geometrychange", onChange);
  window.addEventListener("resize", onChange);
  return () => {
    source?.removeEventListener("geometrychange", onChange);
    window.removeEventListener("resize", onChange);
  };
};

// useSyncExternalStore needs a stable snapshot: serialise, compare as text.
const snapshotKey = (toolbarHeight: number): string =>
  JSON.stringify(readTitlebarArea(overlay(), toolbarHeight, window.innerWidth));

export const useTitlebarArea = (toolbarHeight = 40): TitlebarArea => {
  const key = useSyncExternalStore(subscribe, () => snapshotKey(toolbarHeight));
  return JSON.parse(key) as TitlebarArea;
};
