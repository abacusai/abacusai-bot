import { ipcMain, powerSaveBlocker } from "electron";
import Store from "electron-store";

/**
 * Keep the machine awake while the agent is busy and the preference is on
 * (default on: a sleeping desktop silently kills long runs).
 */

interface PowerStoreSchema {
  keepAwakeEnabled?: boolean;
}

const powerStore = new Store<PowerStoreSchema>({ name: "power" });

let blockerId: number | null = null;
let agentBusy = false;

function isEnabled(): boolean {
  return powerStore.get("keepAwakeEnabled", true) as boolean;
}

function reconcile(): void {
  const shouldBlock = isEnabled() && agentBusy;
  const active = blockerId !== null && powerSaveBlocker.isStarted(blockerId);

  if (shouldBlock && !active) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

export function registerKeepAwakeHandlers(): void {
  ipcMain.handle("power:get-keep-awake", () => isEnabled());

  ipcMain.handle("power:set-keep-awake", (_event, enabled: boolean) => {
    powerStore.set("keepAwakeEnabled", !!enabled);
    reconcile();
    return isEnabled();
  });

  ipcMain.handle("power:set-agent-busy", (_event, busy: boolean) => {
    agentBusy = !!busy;
    reconcile();
  });
}
