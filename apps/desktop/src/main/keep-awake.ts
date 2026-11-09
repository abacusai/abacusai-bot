import { powerMonitor, powerSaveBlocker } from "electron";
import Store from "electron-store";

/**
 * Keep the machine awake while the agent is busy, or a routine is due (from
 * just before its slot until its run settles), and the preference is on
 * (default on: a sleeping desktop silently kills long runs). It cannot stop a
 * lid close or a sleep the user chose; the status board reports what that missed.
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
/** A routine is about to run or running (ServiceHost.followRoutineDue). */
let routineDue = false;

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

/** Follow the host's routine-due signal: its value now, then every change. */
/** Power source changes re-decide a hold that is only for a due routine. */
let watchingPower = false;

export function followRoutineDue(source: {
  followRoutineDue(listener: (due: boolean) => void): () => void;
}): () => void {
  if (!watchingPower) {
    watchingPower = true;
    powerMonitor.on("on-battery", reconcile);
    powerMonitor.on("on-ac", reconcile);
  }
  return source.followRoutineDue((due) => {
    routineDue = due;
    reconcile();
  });
}

function reconcile(): void {
  // A routine that is only due does not drain a laptop on battery.
  const shouldBlock =
    isEnabled() &&
    (mainBusy || (routineDue && !powerMonitor.isOnBatteryPower()));
  const active = blockerId !== null && powerSaveBlocker.isStarted(blockerId);

  if (shouldBlock && !active) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}
