/**
 * The startup theme (spec 01 §7.7, spec 00 "Deferred additions"): main sets
 * `themeSource` from the stored pref before the window exists, and the
 * options `createWindow` hands to `new BaseWindow` (all of them come from
 * `mainWindowOptions`) carry a background in the resolved scheme on every
 * platform. The legacy generation's options are unchanged.
 */
import { describe, expect, it, vi } from "vitest";

import { PrefsStore } from "./services/config/prefs-store";
import {
  applyStartupTheme,
  applyThemedBackground,
  followPrefsTheme,
  mainWindowOptions,
  type ThemeTarget,
} from "./startup-theme";
import {
  WINDOW_SURFACE,
  type LinuxChromeMode,
  type WindowChromeInput,
} from "./window-chrome-options";

/** `nativeTheme` over an OS that is dark or light. */
const fakeNativeTheme = (osDark: boolean): ThemeTarget => {
  let source: ThemeTarget["themeSource"] = "system";
  return {
    get themeSource() {
      return source;
    },
    set themeSource(value) {
      source = value;
    },
    get shouldUseDarkColors() {
      return source === "system" ? osDark : source === "dark";
    },
  };
};

const storedTheme = (theme: "system" | "light" | "dark") => {
  const prefs = new PrefsStore({ file: null });
  prefs.update({ theme });
  return prefs;
};

const BASE = { width: 1200, height: 800, show: false, title: "App" };

/** What `createWindow` passes: `currentChromeInput()` read at call time. */
const windowFor = (options: {
  platform: string;
  stored: "system" | "light" | "dark";
  osDark: boolean;
  reducedTransparency?: boolean;
  linuxMode?: LinuxChromeMode;
}) => {
  const nativeTheme = fakeNativeTheme(options.osDark);
  const seen: string[] = [];
  const chromeInput = (): WindowChromeInput => {
    seen.push(nativeTheme.themeSource);
    return {
      platform: options.platform,
      dark: nativeTheme.shouldUseDarkColors,
      reducedTransparency: options.reducedTransparency ?? false,
      overlayHeight: 40,
      linuxMode: options.linuxMode ?? "overlay",
    };
  };
  const result = mainWindowOptions({
    prefs: storedTheme(options.stored),
    nativeTheme,
    chromeInput,
    base: BASE,
  });
  return { result, nativeTheme, seen };
};

describe("startup theme: the options new BaseWindow gets", () => {
  it("applies the stored theme before the chrome is computed", () => {
    const { nativeTheme, seen } = windowFor({
      platform: "darwin",
      stored: "dark",
      osDark: false,
    });
    expect(seen).toEqual(["dark"]);
    expect(nativeTheme.themeSource).toBe("dark");
  });

  it.each([
    ["light", true, WINDOW_SURFACE.light],
    ["dark", false, WINDOW_SURFACE.dark],
  ] as const)(
    "Linux overlay, stored %s on the opposite OS: the resolved surface, not the overlay's fixed backdrop",
    (stored, osDark, surface) => {
      const { result } = windowFor({
        platform: "linux",
        stored,
        osDark,
      });
      expect(result).toMatchObject({
        ...BASE,
        titleBarStyle: "hidden",
        backgroundColor: surface,
      });
    }
  );

  it("Linux native frame: the resolved surface", () => {
    const { result } = windowFor({
      platform: "linux",
      stored: "dark",
      osDark: false,
      linuxMode: "native-frame",
    });
    expect(result).toEqual({
      ...BASE,
      frame: true,
      backgroundColor: WINDOW_SURFACE.dark,
    });
  });

  it.each(["darwin", "win32"])(
    "%s: transparent while vibrancy/mica paints the backdrop",
    (platform) => {
      const { result } = windowFor({
        platform,
        stored: "dark",
        osDark: false,
      });
      expect(result.backgroundColor).toBe("#00000000");
      expect(
        platform === "darwin" ? result.vibrancy : result.backgroundMaterial
      ).toBe(platform === "darwin" ? "under-window" : "mica");
    }
  );

  it.each(["darwin", "win32"])(
    "%s with reduced transparency: nothing paints the backdrop, so the resolved surface",
    (platform) => {
      const { result } = windowFor({
        platform,
        stored: "light",
        osDark: true,
        reducedTransparency: true,
      });
      expect(result.backgroundColor).toBe(WINDOW_SURFACE.light);
      expect(result.vibrancy).toBeUndefined();
    }
  );
});

describe("startup theme: live", () => {
  const input = (over: Partial<WindowChromeInput>): WindowChromeInput => ({
    platform: "linux",
    dark: false,
    reducedTransparency: false,
    overlayHeight: 40,
    linuxMode: "overlay",
    ...over,
  });
  const fakeWindow = () => ({
    isDestroyed: () => false,
    setBackgroundColor: vi.fn(),
  });

  it("the window and the renderer's view follow the scheme", () => {
    const window = fakeWindow();
    const host = { setBackgroundColor: vi.fn() };
    applyThemedBackground(window, input({ dark: true }), host);
    expect(window.setBackgroundColor).toHaveBeenLastCalledWith(
      WINDOW_SURFACE.dark
    );
    expect(host.setBackgroundColor).toHaveBeenLastCalledWith(
      WINDOW_SURFACE.dark
    );
    applyThemedBackground(
      window,
      input({ platform: "darwin", reducedTransparency: true }),
      host
    );
    expect(host.setBackgroundColor).toHaveBeenLastCalledWith(
      WINDOW_SURFACE.light
    );
  });

  it("applyStartupTheme returns the resolved scheme", () => {
    const nativeTheme = fakeNativeTheme(true);
    expect(applyStartupTheme(storedTheme("light"), nativeTheme)).toBe(false);
    expect(nativeTheme.themeSource).toBe("light");
  });

  it("follows later prefs changes and re-applies the chrome", () => {
    const prefs = new PrefsStore({ file: null });
    const nativeTheme = fakeNativeTheme(false);
    const refresh = vi.fn();
    const off = followPrefsTheme(prefs, nativeTheme, refresh);

    prefs.update({ theme: "dark" });
    expect(nativeTheme.themeSource).toBe("dark");
    prefs.update({ panes: { a: 1 } });
    expect(refresh).toHaveBeenCalledTimes(1);

    off();
    prefs.update({ theme: "light" });
    expect(nativeTheme.themeSource).toBe("dark");
  });
});
