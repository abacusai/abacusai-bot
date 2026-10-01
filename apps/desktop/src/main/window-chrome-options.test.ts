import { EventEmitter } from "node:events";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  applyWindowChrome,
  canSetOverlayLive,
  clampOverlayHeight,
  linuxChromeMode,
  overlayColors,
  subscribeWindowChromeTheme,
  toolbarHeight,
  windowChromeOptions,
  windowChromeState,
  type WindowChromeInput,
} from "./window-chrome-options";

const input: WindowChromeInput = {
  platform: "win32",
  dark: true,
  reducedTransparency: false,
  overlayHeight: 40,
  linuxMode: "overlay",
};

const fakeWindow = () => ({
  isDestroyed: vi.fn(() => false),
  setTitleBarOverlay: vi.fn(),
  setVibrancy: vi.fn(),
  setBackgroundMaterial: vi.fn(),
  setBackgroundColor: vi.fn(),
});

afterEach(() => vi.useRealTimers());

describe.each([false, true])("dark=%s options matrix", (dark) => {
  it.each([false, true])(
    "WCO options, reducedTransparency=%s",
    (reducedTransparency) => {
      const options = {
        ...input,
        dark,
        reducedTransparency,
        overlayHeight: 32,
      };
      expect(windowChromeOptions({ ...options, platform: "darwin" })).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { height: 32 },
        ...(reducedTransparency
          ? {}
          : { vibrancy: "under-window", visualEffectState: "active" }),
      });
      expect(windowChromeOptions(options)).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { ...overlayColors(dark), height: 32 },
        backgroundMaterial: reducedTransparency ? "none" : "mica",
      });
      const color = dark ? "#0a0a0a" : "#ffffff";
      expect(windowChromeOptions({ ...options, platform: "linux" })).toEqual({
        titleBarStyle: "hidden",
        titleBarOverlay: { ...overlayColors(dark), color, height: 32 },
        backgroundColor: "#2a2a28",
      });
      expect(
        windowChromeOptions({
          ...options,
          platform: "linux",
          linuxMode: "native-frame",
        })
      ).toEqual({ frame: true });
    }
  );
});

it.each([
  [{ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "ubuntu:GNOME" }, "overlay"],
  [{ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "KDE" }, "overlay"],
  [{ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "Xfce" }, "overlay"],
  [{ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "X-Cinnamon" }, "overlay"],
  [
    { XDG_SESSION_TYPE: "wayland", XDG_CURRENT_DESKTOP: "GNOME" },
    "native-frame",
  ],
  [{ XDG_SESSION_TYPE: "x11", XDG_CURRENT_DESKTOP: "unknown" }, "native-frame"],
  [{ XDG_CURRENT_DESKTOP: "GNOME" }, "native-frame"],
  [
    {
      XDG_SESSION_TYPE: "x11",
      XDG_CURRENT_DESKTOP: "GNOME",
      ABACUSBOT_NATIVE_FRAME: "1",
    },
    "native-frame",
  ],
  [
    {
      XDG_SESSION_TYPE: "x11",
      XDG_CURRENT_DESKTOP: "GNOME",
      ELECTRON_OZONE_PLATFORM_HINT: "x11",
    },
    "native-frame",
  ],
] as const)("Linux allow-list %j", (env, mode) => {
  expect(linuxChromeMode(env)).toBe(mode);
});

it("maps density independently of native geometry and clamps heights", () => {
  expect(toolbarHeight("comfortable")).toBe(40);
  expect(toolbarHeight("compact")).toBe(32);
  expect([0, 28, 32.6, 64, 100, NaN, Infinity].map(clampOverlayHeight)).toEqual(
    [28, 28, 33, 64, 64, 40, 40]
  );
});

it.each(["darwin", "win32", "linux"])(
  "only supported platforms set overlays live: %s",
  (platform) => {
    expect(canSetOverlayLive(platform)).toBe(platform !== "darwin");
    const window = fakeWindow();
    applyWindowChrome(window, { ...input, platform });
    if (platform === "darwin") {
      expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
      expect(window.setVibrancy).toHaveBeenCalledWith("under-window");
      applyWindowChrome(window, {
        ...input,
        platform,
        reducedTransparency: true,
      });
      expect(window.setVibrancy).toHaveBeenLastCalledWith(null);
      expect(window.setBackgroundMaterial).not.toHaveBeenCalled();
    } else {
      expect(window.setTitleBarOverlay).toHaveBeenCalledOnce();
    }
  }
);

it.each(["win32", "linux"])(
  "explicit and native theme changes retain compact height on %s",
  async (platform) => {
    vi.useFakeTimers();
    const window = fakeWindow();
    const theme = new EventEmitter();
    let dark = false;
    const apply = () =>
      applyWindowChrome(window, {
        ...input,
        platform,
        dark,
        overlayHeight: toolbarHeight("compact"),
      });
    const dispose = subscribeWindowChromeTheme(theme, apply);
    apply();
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 32, symbolColor: "#171717" })
    );
    dark = true;
    apply();
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 32, symbolColor: "#fafafa" })
    );
    dark = false;
    theme.emit("updated");
    theme.emit("updated");
    await vi.runAllTimersAsync();
    expect(window.setTitleBarOverlay).toHaveBeenCalledTimes(3);
    expect(window.setTitleBarOverlay).toHaveBeenLastCalledWith(
      expect.objectContaining({ height: 32, symbolColor: "#171717" })
    );
    if (platform === "linux")
      expect(window.setBackgroundColor).toHaveBeenLastCalledWith("#2a2a28");
    theme.emit("updated");
    dispose();
    await vi.runAllTimersAsync();
    expect(window.setTitleBarOverlay).toHaveBeenCalledTimes(3);
    expect(theme.listenerCount("updated")).toBe(0);
  }
);

it("does not change native-frame Linux or destroyed windows", () => {
  const window = fakeWindow();
  applyWindowChrome(window, {
    ...input,
    platform: "linux",
    linuxMode: "native-frame",
  });
  expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
  window.isDestroyed.mockReturnValue(true);
  applyWindowChrome(window, input);
  expect(window.setTitleBarOverlay).not.toHaveBeenCalled();
});

it("updates the Linux host background together with native chrome", () => {
  const window = fakeWindow();
  const host = { setBackgroundColor: vi.fn() };
  applyWindowChrome(window, { ...input, platform: "linux" }, host);
  expect(window.setBackgroundColor).toHaveBeenCalledWith("#2a2a28");
  expect(host.setBackgroundColor).toHaveBeenCalledWith("#2a2a28");
  applyWindowChrome(window, { ...input, platform: "linux", dark: false }, host);
  expect(host.setBackgroundColor).toHaveBeenLastCalledWith("#2a2a28");
});
