/**
 * `system.info.platform` is a Node platform string; the hotkeys library takes
 * `mac | windows | linux` and resolves `Mod` to Meta only for `mac` (spec 01
 * §7.9, Codex r2 #3).
 */
export type HotkeyPlatform = "mac" | "windows" | "linux";

export const toHotkeyPlatform = (platform: string): HotkeyPlatform =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";

declare const __ABACUS_PLATFORM__: "electron" | "browser";
const PLATFORM = __ABACUS_PLATFORM__;
export const IS_ELECTRON = PLATFORM === "electron";
export const IS_BROWSER = PLATFORM === "browser";
const browserOs = (): string => {
  const os =
    (navigator as Navigator & { userAgentData?: { platform: string } })
      .userAgentData?.platform ?? navigator.platform;
  return /Mac|iPhone|iPad/.test(os)
    ? "darwin"
    : /Win/.test(os)
      ? "win32"
      : "linux";
};
/** The user's OS for hotkeys and labels: the host's on Electron, the browser's otherwise. */
export const uiPlatform = (hostPlatform: string): HotkeyPlatform =>
  toHotkeyPlatform(IS_ELECTRON ? hostPlatform : browserOs());
