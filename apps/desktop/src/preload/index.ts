import { ipcRenderer } from "electron";

import { installMainPreload } from "./main-preload";
import { installRpcPortHandshake, type HandshakeWindow } from "./rpc-port";

if (process.argv.includes("--abacus-window=notch")) {
  installRpcPortHandshake(
    ipcRenderer,
    (globalThis as unknown as { window: HandshakeWindow }).window,
    "notch"
  );
} else {
  installMainPreload();
}
