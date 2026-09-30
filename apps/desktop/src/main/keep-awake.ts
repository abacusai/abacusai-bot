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
/** The legacy renderer's report (`power:set-agent-busy`). */
let agentBusy = false;
/**
 * Main's own: the AG-UI relay's run state (spec 07 review r1 #10), which
 * the new renderer relies on; re-evaluated on every relay busy change.
 */
let mainBusy = false;

function isEnabled(): boolean {
  return powerStore.get("keepAwakeEnabled", true) as boolean;
}

/** Main's authoritative busy aggregate changed. */
export function setMainAgentBusy(busy: boolean): void {
  mainBusy = busy;
  reconcile();
}

function reconcile(): void {
  const shouldBlock = isEnabled() && (agentBusy || mainBusy);
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
