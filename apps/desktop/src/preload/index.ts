import {
  contextBridge,
  ipcRenderer,
  IpcRendererEvent,
  webUtils,
} from "electron";

import type { AccountState } from "#shared/account";
import type { OpenFilePathResult } from "#shared/contracts";
import type { PptxReadResult } from "#shared/pptx";
import type { UpdateStatus } from "#shared/update";

import { createBridge } from "./bridge";

// Read synchronously so the state exists before the first renderer module
// runs; a shell without the store leaves this null (localStorage fallback).
const durableStateSnapshot = ((): Record<string, string> | null => {
  try {
    const snapshot: unknown = ipcRenderer.sendSync("renderer-state:snapshot");

    return typeof snapshot === "object" && snapshot !== null
      ? (snapshot as Record<string, string>)
      : null;
  } catch {
    return null;
  }
})();

// Lets a clicked OS notification focus the originating session.
type NotificationMetadata = {
  workspaceId?: string;
  sessionId?: string;
};

const api = {
  openFolderDialog: (): Promise<string | null> =>
    ipcRenderer.invoke("open-folder-dialog"),
  openFilesDialog: (
    kind?: "all" | "image"
  ): Promise<Array<{
    path: string;
    name: string;
    data: Buffer;
    mimeType: string;
  }> | null> => ipcRenderer.invoke("open-files-dialog", kind),
  // Image currently on the system clipboard, as PNG bytes; null if there is none.
  readClipboardImage: (): Promise<{
    name: string;
    data: Buffer;
    mimeType: string;
  } | null> => ipcRenderer.invoke("read-clipboard-image"),
  // Download a user-supplied http(s) URL for staging as an attachment.
  fetchUrlAttachment: (
    url: string
  ): Promise<{
    success: boolean;
    file?: { name: string; data: Buffer; mimeType: string };
    error?: string;
  }> => ipcRenderer.invoke("fetch-url-attachment", url),

  openExternal: (url: string): Promise<void> =>
    ipcRenderer.invoke("open-external", url),

  // Some paths are revealed or refused; see local-open-guard.
  openFilePath: (filePath: string): Promise<OpenFilePathResult> =>
    ipcRenderer.invoke("open-file-path", filePath),

  showItemInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("show-item-in-folder", filePath),

  getAppVersion: (): Promise<string> => ipcRenderer.invoke("get-app-version"),
  showAboutPanel: (): Promise<void> => ipcRenderer.invoke("window:show-about"),
  isFullScreen: (): Promise<boolean> =>
    ipcRenderer.invoke("window:is-full-screen"),
  onFullScreenChange: (
    callback: (fullScreen: boolean) => void
  ): (() => void) => {
    const listener = (_event: IpcRendererEvent, fullScreen: boolean): void =>
      callback(fullScreen);
    ipcRenderer.on("window:full-screen-changed", listener);
    return () =>
      ipcRenderer.removeListener("window:full-screen-changed", listener);
  },
  restartApp: (): Promise<void> => ipcRenderer.invoke("restart-app"),

  getHomeDir: (): Promise<string> => ipcRenderer.invoke("get-home-dir"),
  hasGoogleChrome: (): Promise<boolean> =>
    ipcRenderer.invoke("has-google-chrome"),
  setThemeSource: (source: "system" | "light" | "dark"): Promise<boolean> =>
    ipcRenderer.invoke("theme:set", source),
  platform: process.platform,

  // Local account (optional sign-in; see apps/desktop/src/shared/account.ts)
  getAccountState: (): Promise<AccountState> =>
    ipcRenderer.invoke("account:get"),
  skipAccountOnboarding: (): Promise<AccountState> =>
    ipcRenderer.invoke("account:skip"),
  signOutAccount: (): Promise<AccountState> =>
    ipcRenderer.invoke("account:sign-out"),
  forgetAccount: (): Promise<AccountState> =>
    ipcRenderer.invoke("account:forget"),

  // Saved under ~/.abacusai-bot/temp; baseFolder kept for API compat.
  savePastedTempFiles: (
    baseFolder: string,
    files: Array<{ name: string; data: Uint8Array }>
  ): Promise<{
    success: boolean;
    dir?: string;
    paths?: string[];
    error?: string;
  }> => ipcRenderer.invoke("save-pasted-temp-files", baseFolder, files),

  // Main cannot see the renderer's console buffer, so it is passed in.
  saveLogs: (
    rendererLogs: string
  ): Promise<{ success: boolean; filePath?: string; error?: string }> =>
    ipcRenderer.invoke("save-logs", rendererLogs),

  // Fire-and-forget: a log line must never make the caller wait on main.
  appendLogs: (lines: string[]): void => {
    ipcRenderer.send("append-logs", lines);
  },

  showNotification: (
    title: string,
    body: string,
    metadata?: NotificationMetadata
  ): Promise<void> =>
    ipcRenderer.invoke("show-notification", title, body, metadata),
  onNotificationClicked: (
    callback: (metadata: NotificationMetadata) => void
  ): (() => void) => {
    const handler = (
      _event: IpcRendererEvent,
      metadata: NotificationMetadata
    ) => callback(metadata);
    ipcRenderer.on("notification-clicked", handler);
    return () => ipcRenderer.removeListener("notification-clicked", handler);
  },

  power: {
    getKeepAwake: (): Promise<boolean> =>
      ipcRenderer.invoke("power:get-keep-awake"),
    setKeepAwake: (enabled: boolean): Promise<boolean> =>
      ipcRenderer.invoke("power:set-keep-awake", enabled),
    // Renderer reports the agent's busy edge; main holds/releases the blocker
    setAgentBusy: (busy: boolean): Promise<void> =>
      ipcRenderer.invoke("power:set-agent-busy", busy),
  },

  update: {
    check: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("update:check"),

    install: (): Promise<{ success: boolean; error?: string }> =>
      ipcRenderer.invoke("update:install"),

    getStatus: (): Promise<UpdateStatus> =>
      ipcRenderer.invoke("update:get-status"),

    onStatusChange: (callback: (status: UpdateStatus) => void) => {
      const handler = (_event: unknown, status: unknown) =>
        callback(status as UpdateStatus);
      ipcRenderer.on("update-status", handler);
      return () => {
        ipcRenderer.removeListener("update-status", handler);
      };
    },
  },
  agent: createBridge(ipcRenderer),
  skills: {
    listInstalled: (request: unknown) =>
      ipcRenderer.invoke("skills-list-installed", request),
    searchMarketplace: (request: unknown) =>
      ipcRenderer.invoke("skills-search-marketplace", request),
    install: (request: unknown) =>
      ipcRenderer.invoke("skills-install", request),
    remove: (request: unknown) => ipcRenderer.invoke("skills-remove", request),
    openFile: (request: unknown) =>
      ipcRenderer.invoke("skills-open-file", request),
    importLocal: (request: unknown) =>
      ipcRenderer.invoke("skills-import-local", request),
  },
  files: {
    readImageAsDataUrl: (args: {
      filePath: string;
      hostRoot: string;
    }): Promise<{
      success: boolean;
      dataUrl?: string;
      mimeType?: string;
      sizeBytes?: number;
      error?: string;
    }> => ipcRenderer.invoke("files:read-image-as-data-url", args),

    readFileAsText: (args: {
      filePath: string;
      hostRoot: string;
      maxBytes?: number;
    }): Promise<{
      success: boolean;
      content?: string;
      sizeBytes?: number;
      truncated?: boolean;
      error?: string;
    }> => ipcRenderer.invoke("files:read-file-as-text", args),

    readPptx: (args: {
      filePath: string;
      hostRoot: string;
    }): Promise<PptxReadResult> => ipcRenderer.invoke("files:read-pptx", args),
  },

  // Runtime versions, for the About dialog.
  versions: process.versions,

  // Durable renderer state (renderer/lib/durable-storage.ts is the consumer).
  durableState: {
    snapshot: durableStateSnapshot,
    set: (key: string, value: string): void => {
      ipcRenderer.send("renderer-state:set", key, value);
    },
    remove: (key: string): void => {
      ipcRenderer.send("renderer-state:set", key, null);
    },
    clear: (): void => {
      ipcRenderer.send("renderer-state:clear");
    },
  },

  // User-input beacon; the renderer swap defers while input is recent.
  reportUiActivity: (): void => {
    ipcRenderer.send("renderer-activity");
  },

  // First React commit done: a swapped-in renderer is shown only after this
  // (or a timeout), so its IPC subscriptions exist before it goes live.
  signalRendererReady: (): void => {
    ipcRenderer.send("renderer-ready");
  },

  // File.path was removed in Electron 32+ with contextIsolation; webUtils is
  // the replacement and runs in the preload context.
  getPathForFile: (file: File): string => webUtils.getPathForFile(file),
};

// Expose through contextBridge when isolated, else on the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld("api", api);
  } catch (error) {
    console.error(error);
  }
} else {
  // @ts-expect-error (define in dts)
  window.api = api;
}
