/**
 * The startup theme (spec 01 §7.7, spec 00 "Deferred additions"): main sets
 * `themeSource` from the stored pref before the window exists, and the
 * window's first opaque background follows the resolved scheme.
 */
import { describe, expect, it, vi } from "vitest";

import { PrefsStore } from "./services/config/prefs-store";
import {
  applyStartupTheme,
  followPrefsTheme,
  startupBackgroundColor,
  type ThemeTarget,
} from "./startup-theme";
import { WINDOW_SURFACE } from "./window-chrome-options";

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

describe("startup theme", () => {
  it("applies a stored dark theme on a light OS before the window exists", () => {
    const nativeTheme = fakeNativeTheme(false);
    const order: string[] = [];
    const createWindow = () => {
      order.push(`window:${nativeTheme.themeSource}`);
    };

    const dark = applyStartupTheme(storedTheme("dark"), nativeTheme);
    createWindow();

    expect(dark).toBe(true);
    expect(order).toEqual(["window:dark"]);
    expect(startupBackgroundColor("#2a2a28", dark)).toBe(WINDOW_SURFACE.dark);
  });

  it("applies a stored light theme on a dark OS", () => {
    const nativeTheme = fakeNativeTheme(true);
    const dark = applyStartupTheme(storedTheme("light"), nativeTheme);
    expect(nativeTheme.themeSource).toBe("light");
    expect(dark).toBe(false);
    expect(startupBackgroundColor("#2a2a28", dark)).toBe(WINDOW_SURFACE.light);
  });

  it("follows the OS for system and keeps a transparent backdrop", () => {
    const nativeTheme = fakeNativeTheme(true);
    expect(applyStartupTheme(storedTheme("system"), nativeTheme)).toBe(true);
    expect(startupBackgroundColor("#00000000", true)).toBe("#00000000");
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
