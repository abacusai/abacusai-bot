/**
 * The one bridge an installed artifact app gets: its own saved data. Values
 * are anything JSON can hold; `set(key, null)` removes a key. Nothing else of
 * the app (no model, no files, no network) is reachable from the page.
 */
import { contextBridge, ipcRenderer } from "electron";

export const installArtifactAppPreload = (): void =>
  contextBridge.exposeInMainWorld("abacus", {
    store: {
      get: (key: string): Promise<unknown> =>
        ipcRenderer.invoke("artifact-app:store-get", key),
      set: (key: string, value: unknown): Promise<void> =>
        ipcRenderer.invoke("artifact-app:store-set", key, value),
      keys: (): Promise<string[]> =>
        ipcRenderer.invoke("artifact-app:store-keys"),
    },
  });
