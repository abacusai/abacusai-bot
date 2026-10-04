/**
 * `system.info.platform` is a Node platform string; the hotkeys library takes
 * `mac | windows | linux` and resolves `Mod` to Meta only for `mac` (spec 01
 * §7.9, Codex r2 #3).
 */
export type HotkeyPlatform = "mac" | "windows" | "linux";

export const toHotkeyPlatform = (platform: string): HotkeyPlatform =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";

declare const __ABACUS_PLATFORM__: "electron" | "browser";
export const PLATFORM = __ABACUS_PLATFORM__;
export const IS_ELECTRON = PLATFORM === "electron";
export const IS_BROWSER = PLATFORM === "browser";
export const uiPlatform = (hostPlatform: string): HotkeyPlatform =>
  IS_ELECTRON
    ? toHotkeyPlatform(hostPlatform)
    : toHotkeyPlatform(
        /Mac|iPhone|iPad/.test(navigator.platform)
          ? "darwin"
          : /Win/.test(navigator.platform)
            ? "win32"
            : "linux"
      );
