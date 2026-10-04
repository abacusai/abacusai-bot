/**
 * What a browser tab gets in place of a desktop window, for connections that
 * come from the hosted web app (its own server, or this desktop serving its
 * coding view): a plain page that is always shown and focused, with no native
 * frame, and settings whose API keys are never sent, only marked as set.
 */
import type { WindowState } from "#shared/contract";
import type { WindowChromeState } from "#shared/window-chrome-state";

import type { RpcDeps } from "./deps";

export const TAB_WINDOW_STATE: WindowState = {
  fullScreen: false,
  focused: true,
  maximized: false,
};

export const TAB_CHROME_STATE: WindowChromeState = {
  mode: "native-frame",
  fullScreen: false,
  density: "comfortable",
  // A page has no title bar of its own; the app's top bar keeps its height.
  toolbarHeight: 40,
};

/** Every tab is a window to the window-scoped procedures, never a real one. */
export const tabWindows = (base?: RpcDeps["windows"]): RpcDeps["windows"] => ({
  mainRendererId: () => base?.mainRendererId() ?? null,
  contents: () => null,
  state: () => TAB_WINDOW_STATE,
  chrome: () => TAB_CHROME_STATE,
  reportReady: () => undefined,
});

/** Shown to tabs in place of every stored key: set, and nothing more. */
const REDACTED_KEY = "configured";

export const redactApiKeys = <T extends { apiKeys?: Record<string, string> }>(
  settings: T
): T =>
  settings.apiKeys == null
    ? settings
    : {
        ...settings,
        apiKeys: Object.fromEntries(
          Object.entries(settings.apiKeys).map(([name, key]) => [
            name,
            key.trim().length > 0 ? REDACTED_KEY : "",
          ])
        ),
      };

/** `settings.get` for a tab: the settings file without its keys. */
export const tabHost = (host: RpcDeps["host"]): RpcDeps["host"] => ({
  ...host,
  readSettings: () => redactApiKeys(host.readSettings()),
});
