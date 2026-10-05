// TODO(renderer cut-over, docs/rewrite/specs/00-window-chrome.md §7): remove
// shared/window-chrome.ts and its tests; renderer TITLEBAR_* constants,
// titlebarStartInset(), isWindows, --workspace-topbar-height,
// --titlebar-start-inset, WebkitAppRegion styles, the macOS fullscreen inset
// branch, useWindowFullScreen, isFullScreen(), onFullScreenChange(), and the
// window:is-full-screen / window:full-screen-changed channels.
// Resize WindowDragRegion with --toolbar-h and migrate Toaster/layout consumers.
import type { BaseWindowConstructorOptions } from "electron";

import {
  MACOS_TRAFFIC_LIGHT_POSITION,
  windowChromeMetrics,
} from "#shared/window-chrome";

export type WindowChromeMode = "legacy" | "wco";
export type LinuxChromeMode = "overlay" | "native-frame";
export type TitlebarDensity = "comfortable" | "compact";
export type ChromeCapability =
  | "overlay-pending"
  | "overlay"
  | "overlay-unavailable"
  | "native-frame";

// Resolved --background values from renderer/assets/base.css. Keep these in
// sync with renderer/lib/tokens.css when the new renderer introduces that file.
export const WINDOW_SURFACE = { light: "#ffffff", dark: "#0a0a0a" } as const;
const TITLEBAR_SURFACE = WINDOW_SURFACE;

export function overlayColors(dark: boolean) {
  return {
    color: "#00000000",
    symbolColor: dark ? "#fafafa" : "#171717",
  };
}

export function clampOverlayHeight(height: number): number {
  return Number.isFinite(height)
    ? Math.min(64, Math.max(28, Math.round(height)))
    : 40;
}

// The app toolbar never takes its height from native overlay geometry, which
// can be empty in fullscreen. Legacy ignores density until renderer cut-over.
export function toolbarHeight(density: TitlebarDensity): number {
  return clampOverlayHeight(density === "compact" ? 32 : 40);
}

export function linuxChromeMode(
  env: Record<string, string | undefined>
): LinuxChromeMode {
  if (
    env.ABACUSBOT_NATIVE_FRAME === "1" ||
    env.ELECTRON_OZONE_PLATFORM_HINT !== undefined ||
    env.XDG_SESSION_TYPE?.toLowerCase() !== "x11"
  ) {
    return "native-frame";
  }
  const desktops = (env.XDG_CURRENT_DESKTOP ?? "").toLowerCase().split(":");
  return desktops.some((desktop) =>
    ["gnome", "kde", "xfce", "cinnamon", "x-cinnamon"].includes(desktop)
  )
    ? "overlay"
    : "native-frame";
}

export interface WindowChromeInput {
  mode: WindowChromeMode;
  platform: string;
  dark: boolean;
  reducedTransparency: boolean;
  overlayHeight: number;
  linuxMode?: LinuxChromeMode;
}

export function windowChromeOptions({
  mode,
  platform,
  dark,
  reducedTransparency,
  overlayHeight,
  linuxMode = "native-frame",
}: WindowChromeInput): BaseWindowConstructorOptions {
  if (platform === "darwin") {
    return {
      titleBarStyle: mode === "legacy" ? "hiddenInset" : "hidden",
      ...(mode === "legacy"
        ? { trafficLightPosition: MACOS_TRAFFIC_LIGHT_POSITION }
        : { titleBarOverlay: { height: clampOverlayHeight(overlayHeight) } }),
      ...(reducedTransparency
        ? {}
        : { vibrancy: "under-window", visualEffectState: "active" }),
    };
  }
  if (platform === "win32") {
    return {
      titleBarStyle: "hidden",
      titleBarOverlay: {
        ...overlayColors(dark),
        height:
          mode === "legacy"
            ? windowChromeMetrics("win32").titlebarHeight
            : clampOverlayHeight(overlayHeight),
      },
      backgroundMaterial: reducedTransparency ? "none" : "mica",
    };
  }
  if (mode === "legacy" || linuxMode === "native-frame") return { frame: true };
  const color = dark ? TITLEBAR_SURFACE.dark : TITLEBAR_SURFACE.light;
  return {
    titleBarStyle: "hidden",
    titleBarOverlay: {
      ...overlayColors(dark),
      color,
      height: clampOverlayHeight(overlayHeight),
    },
    // Linux has no vibrancy/material; retain the opaque window backdrop.
    backgroundColor: "#2a2a28",
  };
}

export function canSetOverlayLive(platform: string): boolean {
  return platform === "win32" || platform === "linux";
}

export interface ChromeWindow {
  isDestroyed(): boolean;
  setTitleBarOverlay(options: {
    color?: string;
    symbolColor?: string;
    height?: number;
  }): void;
  setVibrancy(value: "under-window" | null): void;
  setBackgroundMaterial(value: "mica" | "none"): void;
  setBackgroundColor(value: string): void;
}

export function applyWindowChrome(
  window: ChromeWindow,
  input: WindowChromeInput,
  host?: { setBackgroundColor(value: string): void }
): void {
  if (window.isDestroyed()) return;
  const options = windowChromeOptions(input);
  if (
    canSetOverlayLive(input.platform) &&
    typeof options.titleBarOverlay === "object"
  ) {
    window.setTitleBarOverlay(options.titleBarOverlay);
  }
  if (input.platform === "darwin") {
    window.setVibrancy(input.reducedTransparency ? null : "under-window");
  } else if (input.platform === "win32") {
    window.setBackgroundMaterial(input.reducedTransparency ? "none" : "mica");
  } else if (options.backgroundColor !== undefined) {
    window.setBackgroundColor(options.backgroundColor);
    host?.setBackgroundColor(options.backgroundColor);
  }
}

export interface ChromeTheme {
  on(event: "updated", listener: () => void): unknown;
  off(event: "updated", listener: () => void): unknown;
}

/** Coalesce native theme bursts; also cancel pending work on window disposal. */
export function subscribeWindowChromeTheme(
  theme: ChromeTheme,
  apply: () => void
): () => void {
  let pending: ReturnType<typeof setImmediate> | undefined;
  const updated = () => {
    if (pending !== undefined) return;
    pending = setImmediate(() => {
      pending = undefined;
      apply();
    });
  };
  theme.on("updated", updated);
  return () => {
    theme.off("updated", updated);
    if (pending !== undefined) clearImmediate(pending);
  };
}

export function windowChromeState(
  input: WindowChromeInput,
  capability: ChromeCapability,
  fullScreen: boolean
) {
  return {
    mode:
      input.mode === "legacy"
        ? input.platform === "darwin" || input.platform === "win32"
          ? "overlay"
          : "native-frame"
        : capability,
    fullScreen,
    density:
      input.mode === "legacy"
        ? ("comfortable" as const)
        : input.overlayHeight === 32
          ? ("compact" as const)
          : ("comfortable" as const),
    toolbarHeight:
      input.mode === "legacy"
        ? windowChromeMetrics(input.platform).titlebarHeight
        : input.overlayHeight,
  };
}
