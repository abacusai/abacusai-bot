import { contextBridge, ipcRenderer, webUtils } from "electron";

import { installRpcPortHandshake, type HandshakeWindow } from "./rpc-port";
export function installMainPreload(): void {
  installRpcPortHandshake(
    ipcRenderer,
    (globalThis as unknown as { window: HandshakeWindow }).window,
    "main"
  );
  const abacusHost = {
    getPathForFile: (file: File): string => webUtils.getPathForFile(file),
  };
  if (process.contextIsolated)
    contextBridge.exposeInMainWorld("abacusHost", abacusHost);
  else Object.assign(window, { abacusHost });
}
