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
/**
 * The legacy renderer's reports (`power:set-agent-busy`), per sender
 * webContents. A report lives only as long as the document that made it: it
 * is dropped when that webContents is destroyed, its renderer process goes,
 * or it navigates away (a reload or a swap), since the old renderer clears
 * it only from an effect cleanup that a crash never runs.
 */
const legacyReports = new Map<number, boolean>();
/** Senders whose lifetime events are already followed. */
const followedSenders = new Set<number>();
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

function legacyBusy(): boolean {
  for (const busy of legacyReports.values()) if (busy) return true;
  return false;
}

function reconcile(): void {
  const shouldBlock = isEnabled() && (legacyBusy() || mainBusy);
  const active = blockerId !== null && powerSaveBlocker.isStarted(blockerId);

  if (shouldBlock && !active) {
    blockerId = powerSaveBlocker.start("prevent-app-suspension");
  } else if (!shouldBlock && active && blockerId !== null) {
    powerSaveBlocker.stop(blockerId);
    blockerId = null;
  }
}

/** The parts of a sender's webContents keep-awake listens to. */
interface ReportingSender {
  readonly id: number;
  once(event: "destroyed", listener: () => void): unknown;
  on(
    event: "render-process-gone",
    listener: (...args: unknown[]) => void
  ): unknown;
  on(
    event: "did-start-navigation",
    listener: (
      event: unknown,
      url: string,
      isSameDocument: boolean,
      isMainFrame: boolean
    ) => void
  ): unknown;
}

function forgetSender(id: number): void {
  if (!legacyReports.delete(id)) return;
  reconcile();
}

function followSender(sender: ReportingSender): void {
  const id = sender.id;
  if (followedSenders.has(id)) return;
  followedSenders.add(id);
  sender.once("destroyed", () => {
    followedSenders.delete(id);
    forgetSender(id);
  });
  sender.on("render-process-gone", () => forgetSender(id));
  sender.on(
    "did-start-navigation",
    (_event, _url, isSameDocument, isMainFrame) => {
      if (isMainFrame && !isSameDocument) forgetSender(id);
    }
  );
}

export function registerKeepAwakeHandlers(): void {
  ipcMain.handle("power:get-keep-awake", () => isEnabled());

  ipcMain.handle("power:set-keep-awake", (_event, enabled: boolean) => {
    powerStore.set("keepAwakeEnabled", !!enabled);
    reconcile();
    return isEnabled();
  });

  ipcMain.handle("power:set-agent-busy", (event, busy: boolean) => {
    const sender = event.sender as unknown as ReportingSender;
    followSender(sender);
    legacyReports.set(sender.id, !!busy);
    reconcile();
  });
}
