/**
 * `system.info.platform` is a Node platform string; the hotkeys library takes
 * `mac | windows | linux` and resolves `Mod` to Meta only for `mac` (spec 01
 * §7.9, Codex r2 #3).
 */
export type HotkeyPlatform = "mac" | "windows" | "linux";

export const toHotkeyPlatform = (platform: string): HotkeyPlatform =>
  platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
