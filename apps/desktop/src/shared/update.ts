export interface UpdateProgress {
  percent: number;
  bytesPerSecond: number;
  total: number;
  transferred: number;
}

/** Updater state, emitted by the main process on the `update-status` channel. */
export interface UpdateStatus {
  checking: boolean;
  available: boolean;
  downloading: boolean;
  downloaded: boolean;
  /** The install was handed to the platform updater; the app is on its way out. */
  installing: boolean;
  error: string | null;
  progress: UpdateProgress | null;
  updateInfo: { version: string } | null;
  /** Install was requested but the app never quit — the update can't be applied. */
  installStalled: boolean;
  /** The running version is below the feed's criticalBelow — a P0 escalation. */
  criticalUpdate: boolean;
}
