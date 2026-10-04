import { readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";

import { trashItem } from "./filesystem";
import { HostUnsupportedError } from "./unsupported";
const botHome = () =>
  process.env.ABACUSAI_BOT_HOME || join(homedir(), ".abacusai-bot");
const unavailable = (name: string): any =>
  new Proxy(
    function () {
      throw new HostUnsupportedError(name);
    },
    {
      get: (_target, member) => {
        if (member === "then") return undefined;
        return unavailable(`${name}.${String(member)}`);
      },
      apply: () => {
        throw new HostUnsupportedError(name);
      },
      construct: () => {
        throw new HostUnsupportedError(name);
      },
    }
  );
export const app = {
  getVersion: () => {
    if (process.env.ABACUSAI_BOT_HOST_VERSION)
      return process.env.ABACUSAI_BOT_HOST_VERSION;
    for (const file of ["package.json", "../package.json"]) {
      try {
        return JSON.parse(readFileSync(join(import.meta.dirname, file), "utf8"))
          .version as string;
      } catch {
        /* Source and bundled manifests sit at different depths. */
      }
    }
    throw new Error("Host package manifest missing");
  },
  getPath: (kind: string) => {
    switch (kind) {
      case "home":
        return homedir();
      case "userData":
        return join(botHome(), "host-userdata");
      case "temp":
        return tmpdir();
      case "logs":
        return join(botHome(), "host", "log");
      default:
        throw new HostUnsupportedError(`app.getPath(${kind})`);
    }
  },
  isPackaged: false,
  getLocale: () => "en-US",
  userAgentFallback:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0.0.0 Safari/537.36",
  getApplicationNameForProtocol: () => "",
  relaunch: () => process.exit(75),
  quit: () => process.exit(75),
};
export const shell = {
  trashItem,
  openPath: async (_file: string) => "not available on the web host",
  openExternal: async (_url: string) => {
    throw new HostUnsupportedError("shell.openExternal");
  },
  showItemInFolder: (_file: string) => {},
};
export const net = { fetch: globalThis.fetch };
export const nativeTheme = {
  shouldUseDarkColors: false,
  themeSource: "system",
  on() {},
};

// Value exports are pinned by the Electron import drift test.
export const BaseWindow = unavailable("BaseWindow");
export const BrowserWindow = unavailable("BrowserWindow");
export const Menu = unavailable("Menu");
export const Notification = unavailable("Notification");
export const WebContentsView = unavailable("WebContentsView");
export const autoUpdater = unavailable("autoUpdater");
export const contextBridge = unavailable("contextBridge");
export const crashReporter = unavailable("crashReporter");
export const desktopCapturer = unavailable("desktopCapturer");
export const dialog = unavailable("dialog");
export const globalShortcut = unavailable("globalShortcut");
export const ipcMain = unavailable("ipcMain");
export const ipcRenderer = unavailable("ipcRenderer");
export const nativeImage = unavailable("nativeImage");
export const powerMonitor = unavailable("powerMonitor");
export const powerSaveBlocker = unavailable("powerSaveBlocker");
export const protocol = unavailable("protocol");
export const screen = unavailable("screen");
export const session = unavailable("session");
export const systemPreferences = unavailable("systemPreferences");
export const webContents = unavailable("webContents");
export const webUtils = unavailable("webUtils");
