import Store from "electron-store";

import { abacusBotHome } from "./paths";
import type { TitlebarDensity } from "./window-chrome-options";

interface ChromeSettings {
  titlebarDensity: TitlebarDensity;
  linuxNativeFrameKey?: string;
}

let settings: Store<ChromeSettings> | undefined;
function settingsStore(): Store<ChromeSettings> {
  return (settings ??= new Store<ChromeSettings>({
    name: "settings",
    cwd: abacusBotHome(),
    clearInvalidConfig: true,
    defaults: { titlebarDensity: "comfortable" },
  }));
}

export function linuxNativeFrameKey(
  electronVersion = process.versions.electron,
  desktop = process.env.XDG_CURRENT_DESKTOP ?? "unknown"
): string {
  return JSON.stringify([electronVersion, desktop.toLowerCase()]);
}

export function getTitlebarDensity(): TitlebarDensity {
  return settingsStore().get("titlebarDensity") === "compact"
    ? "compact"
    : "comfortable";
}

export function setTitlebarDensity(value: unknown): TitlebarDensity {
  if (value !== "comfortable" && value !== "compact") {
    throw new Error("Invalid titlebar density");
  }
  settingsStore().set("titlebarDensity", value);
  return value;
}

export function useLinuxNativeFrame(key = linuxNativeFrameKey()): boolean {
  return settingsStore().get("linuxNativeFrameKey") === key;
}

export function persistLinuxNativeFrame(key = linuxNativeFrameKey()): void {
  settingsStore().set("linuxNativeFrameKey", key);
}
