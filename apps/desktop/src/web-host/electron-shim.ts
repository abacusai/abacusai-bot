/**
 * What `electron` resolves to in the web host's bundle. The main process's
 * services import Electron at module scope, but the ones the hosted app runs
 * (bots, chat, memory, connectors) only touch a handful of `app` facts and
 * `shell.openExternal`. Those answer here; everything that would need a
 * window, a native dialog or the OS answers "not available on the web" when
 * called, never when imported, so a module that merely mentions a window
 * still loads.
 */
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { abacusBotHome } from "#main/paths";

const unavailable = (what: string): never => {
  throw new Error(`${what} is not available in the web app`);
};

/** Every member a function that throws naming itself. */
const unavailableObject = <T extends object>(name: string, base = {}): T =>
  new Proxy(base, {
    get(target, property) {
      if (property in target)
        return (target as Record<PropertyKey, unknown>)[property];
      if (typeof property !== "string" || property === "then") return undefined;
      return () => unavailable(`${name}.${property}`);
    },
  }) as T;

class UnavailableClass {
  constructor() {
    unavailable(new.target.name);
  }
}

/** `shell.openExternal` hands the URL to the browser tab that asked. */
type OpenExternalHandler = (url: string) => void;
let openExternalHandler: OpenExternalHandler = () => undefined;

export const setOpenExternalHandler = (handler: OpenExternalHandler): void => {
  openExternalHandler = handler;
};

const appEvents = new EventEmitter();

const paths = (): Record<string, string> => {
  const home = abacusBotHome();
  return {
    home,
    appData: join(home, "app-data"),
    userData: join(home, "app-data"),
    sessionData: join(home, "app-data"),
    logs: join(home, "logs"),
    temp: tmpdir(),
    downloads: join(home, "downloads"),
    documents: home,
    desktop: home,
    exe: process.execPath,
    module: process.execPath,
  };
};

export const app = Object.assign(appEvents, {
  isPackaged: false,
  userAgentFallback: "",
  commandLine: { appendSwitch: () => undefined, hasSwitch: () => false },
  getVersion: () => process.env.ABACUSAI_BOT_WEB_VERSION ?? "0.0.0-web",
  getName: () => "AbacusAI-Bot",
  setName: () => undefined,
  getLocale: () => "en-US",
  getSystemLocale: () => "en-US",
  getPreferredSystemLanguages: () => ["en-US"],
  getAppPath: () => process.cwd(),
  getPath: (name: string) =>
    paths()[name] ?? unavailable(`app.getPath("${name}")`),
  setPath: () => undefined,
  isReady: () => true,
  whenReady: () => Promise.resolve(),
  focus: () => undefined,
  quit: () => process.exit(0),
  exit: (code?: number) => process.exit(code ?? 0),
  relaunch: () => unavailable("app.relaunch"),
  requestSingleInstanceLock: () => true,
  setLoginItemSettings: () => undefined,
  getLoginItemSettings: () => ({ openAtLogin: false }),
  getApplicationNameForProtocol: () => "",
  setAppUserModelId: () => undefined,
  dock: undefined,
});

export const shell = {
  openExternal: (url: string): Promise<void> => {
    openExternalHandler(url);
    return Promise.resolve();
  },
  openPath: (): Promise<string> =>
    Promise.resolve("Opening files is not available in the web app"),
  showItemInFolder: (): void => undefined,
  trashItem: (): Promise<void> => unavailable("shell.trashItem"),
  beep: (): void => undefined,
};

export const ipcMain = Object.assign(new EventEmitter(), {
  handle: () => undefined,
  handleOnce: () => undefined,
  removeHandler: () => undefined,
});

export const nativeTheme = Object.assign(new EventEmitter(), {
  shouldUseDarkColors: false,
  themeSource: "system",
});

export const powerMonitor = Object.assign(new EventEmitter(), {
  getSystemIdleTime: () => 0,
});

export const powerSaveBlocker = {
  start: () => 0,
  stop: () => undefined,
  isStarted: () => false,
};

export const net = {
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    fetch(input, init),
  isOnline: () => true,
};

export const webContents = {
  fromId: () => null,
  getAllWebContents: () => [],
  getFocusedWebContents: () => null,
};

export const nativeImage = unavailableObject("nativeImage", {
  createEmpty: () => unavailableObject("NativeImage", { isEmpty: () => true }),
});

export const screen = unavailableObject("screen");
export const dialog = unavailableObject("dialog");
export const session = unavailableObject("session");
export const protocol = unavailableObject("protocol", {
  registerSchemesAsPrivileged: () => undefined,
});
export const systemPreferences = unavailableObject("systemPreferences", {
  getMediaAccessStatus: () => "denied",
});
export const globalShortcut = unavailableObject("globalShortcut");
export const crashReporter = unavailableObject("crashReporter", {
  start: () => undefined,
});
export const autoUpdater = unavailableObject("autoUpdater");
/** Absent, as in any main process: electron-store tells the two apart by it. */
export const ipcRenderer = undefined;

export class Notification extends EventEmitter {
  static isSupported(): boolean {
    return false;
  }
  show(): void {}
  close(): void {}
}

export class BaseWindow extends UnavailableClass {}
export class BrowserWindow extends UnavailableClass {}
export class WebContentsView extends UnavailableClass {}
export class MessageChannelMain extends UnavailableClass {}
export class Menu extends UnavailableClass {
  static setApplicationMenu(): void {}
  static buildFromTemplate(): never {
    return unavailable("Menu");
  }
}
export class Tray extends UnavailableClass {}

export default {
  app,
  shell,
  ipcMain,
  nativeTheme,
  powerMonitor,
  powerSaveBlocker,
  net,
  webContents,
  nativeImage,
  screen,
  dialog,
  session,
  protocol,
  systemPreferences,
  globalShortcut,
  crashReporter,
  autoUpdater,
  ipcRenderer,
  Notification,
  BaseWindow,
  BrowserWindow,
  WebContentsView,
  MessageChannelMain,
  Menu,
  Tray,
};
