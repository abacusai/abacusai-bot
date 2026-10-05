import { powerSaveBlocker } from "electron";
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
/**
 * The legacy renderer's reports (`power:set-agent-busy`), per sender
 * webContents. A report lives only as long as the document that made it: it
 * is dropped when that webContents is destroyed, its renderer process goes,
 * or it navigates away (a reload or a swap), since the old renderer clears
 * it only from an effect cleanup that a crash never runs.
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

/**
 * Follow a busy source (the AG-UI relay): its current value now, then every
 * change. Registration may come after the source started, so the value it
 * already has is not missed.
 */
export function followMainAgentBusy(source: {
  readonly busy: boolean;
  onBusyChange(listener: (busy: boolean) => void): () => void;
}): () => void {
  const stop = source.onBusyChange((busy) => setMainAgentBusy(busy));
  setMainAgentBusy(source.busy);
  return stop;
}

function reconcile(): void {
  const shouldBlock = isEnabled() && mainBusy;
  const active = blockerId !== null && powerSaveBlocker.isStarted(blockerId);

  if (shouldBlock && !active) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}
