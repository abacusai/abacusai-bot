import Store from "electron-store";

import type { LinuxChromeMode, TitlebarDensity } from "./window-chrome-options";

interface ChromeSettings {
  titlebarDensity: TitlebarDensity;
  linuxChromeMode?: LinuxChromeMode;
}

const settings = new Store<ChromeSettings>({
  name: "settings",
  clearInvalidConfig: true,
  defaults: { titlebarDensity: "comfortable" },
});

export function getTitlebarDensity(): TitlebarDensity {
  return settings.get("titlebarDensity") === "compact"
    ? "compact"
    : "comfortable";
}

export function setTitlebarDensity(value: unknown): TitlebarDensity {
  if (value !== "comfortable" && value !== "compact") {
    throw new Error("Invalid titlebar density");
  }
  settings.set("titlebarDensity", value);
  return value;
}

export function useLinuxNativeFrame(): boolean {
  return settings.get("linuxChromeMode") === "native-frame";
}

export function persistLinuxNativeFrame(): void {
  settings.set("linuxChromeMode", "native-frame");
}
