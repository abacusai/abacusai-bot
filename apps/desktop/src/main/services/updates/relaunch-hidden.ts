import Store from "electron-store";

/**
 * One-shot hint across an update restart: the window was hidden when the quit
 * started, so come back hidden. On disk because it crosses the process
 * boundary. It expires so that, if the installer never relaunches us, a
 * manual launch days later does not start hidden.
 */
const RELAUNCH_HIDDEN_TTL_MS = 5 * 60 * 1000;

interface UpdatesStoreSchema {
  relaunchHiddenUntil?: number;
}

const updatesStore = new Store<UpdatesStoreSchema>({
  name: "updates",
  clearInvalidConfig: true,
});

/** Record that the next launch, if it comes soon, should not show a window. */
export function markRelaunchHidden(): void {
  updatesStore.set("relaunchHiddenUntil", Date.now() + RELAUNCH_HIDDEN_TTL_MS);
}

/** Undo the mark — the install hand-off failed, no restart is coming. */
export function clearRelaunchHidden(): void {
  updatesStore.delete("relaunchHiddenUntil");
}

/** Read-and-clear at startup: true if this launch should start hidden. */
export function consumeRelaunchHidden(): boolean {
  const until = updatesStore.get("relaunchHiddenUntil");
  if (until == null) return false;
  updatesStore.delete("relaunchHiddenUntil");
  return Date.now() < until;
}
