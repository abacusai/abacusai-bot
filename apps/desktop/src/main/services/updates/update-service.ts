// electron-updater is CommonJS; a named value import fails at load under ESM.
import electronUpdater, { type UpdateInfo } from "electron-updater";

const { autoUpdater } = electronUpdater;
import { app, BaseWindow, powerMonitor } from "electron";

import { sendToRenderer } from "#main/renderer-host";
import type { UpdateStatus } from "#shared/update";

import { markQuitting, clearQuitting } from "../../app-quit-state";
import { markRelaunchHidden, clearRelaunchHidden } from "./relaunch-hidden";

// Static CDN feed: one YAML naming immutable per-version artifacts. The feed
// flip is the last, atomic step of a release.
const DEFAULT_UPDATE_FEED_URL =
  "https://downloads.abacus.ai/abacusai-bot/latest";

// The override is a developer affordance and powerless in a packaged build: an
// attacker-set env var must never redirect a signed app to a hostile feed (on
// Linux that is arbitrary-binary RCE). Unpackaged, https, abacus.ai host only.
const resolveFeedUrl = (): string => {
  const raw = process.env.ABACUSAI_BOT_UPDATE_FEED_URL?.trim();
  if (!raw || app.isPackaged) return DEFAULT_UPDATE_FEED_URL;
  try {
    const url = new URL(raw);
    const host = url.hostname.toLowerCase();
    if (
      url.protocol === "https:" &&
      (host === "abacus.ai" || host.endsWith(".abacus.ai"))
    ) {
      return raw;
    }
  } catch {
    // fall through to the default
  }
  return DEFAULT_UPDATE_FEED_URL;
};
const UPDATE_FEED_URL = resolveFeedUrl();

// `criticalBelow`: older running versions get the blocking dialog, not a pill.
const RELEASE_METADATA_URL = `${UPDATE_FEED_URL}/release-metadata.json`;
const RELEASE_METADATA_TIMEOUT_MS = 10_000;

// Above the CDN's 300s feed cache, so polls are answered from the edge.
const UPDATE_CHECK_INTERVAL_MS = 10 * 60 * 1000;

// Idle threshold before a downloaded update may apply itself.
const AUTO_RESTART_IDLE_SECONDS = 10 * 60;
const AUTO_RESTART_POLL_MS = 60_000;

// After quitAndInstall() only our own exit stands between the user and the
// update: normal quit first, then hard-exit. 15s clears the 6s cleanup cap.
const QUIT_STALL_MS = 15_000;
const QUIT_FORCE_MS = 30_000;

// a < b over dotted numeric versions; bad segments count as 0, which only
// errs toward "not critical".
function versionLessThan(a: string, b: string): boolean {
  const parse = (v: string) =>
    v.split(".").map((seg) => Number.parseInt(seg, 10) || 0);
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const [x, y] = [pa[i] ?? 0, pb[i] ?? 0];
    if (x !== y) return x < y;
  }
  return false;
}

/** Host knowledge: an agent turn or live PTY makes a restart destructive. */
export interface UpdateServiceDeps {
  isSafeToRestart?: () => boolean;
}

const initialStatus = (): UpdateStatus => ({
  checking: false,
  available: false,
  downloading: false,
  downloaded: false,
  installing: false,
  error: null,
  progress: null,
  updateInfo: null,
  installStalled: false,
  criticalUpdate: false,
});

export class UpdateService {
  private status = initialStatus();

  private checkTimer: NodeJS.Timeout | null = null;
  private autoRestartTimer: NodeJS.Timeout | null = null;

  // On disk, as opposed to the feed's last offer (`status.updateInfo`); they
  // diverge when the pending install is superseded.
  private downloadedVersion: string | null = null;

  /** Consecutive checks that did not offer the downloaded build. */
  private notOfferedStrikes = 0;

  constructor(private readonly deps: UpdateServiceDeps = {}) {
    this.setupAutoUpdater();
  }

  private setupAutoUpdater(): void {
    try {
      autoUpdater.setFeedURL({ provider: "generic", url: UPDATE_FEED_URL });
    } catch (err) {
      console.error("[UpdateService] Failed to set feed URL:", err);
    }

    // autoDownload / autoInstallOnAppQuit: see setUpdaterHasPendingBuild().

    autoUpdater.logger = {
      info: () => {},
      debug: () => {},
      warn: (msg) => console.warn(`[UpdateService] ${msg}`),
      error: (msg) => console.error(`[UpdateService] ${msg}`),
    };

    autoUpdater.on("checking-for-update", () => {
      console.log(`[UpdateService] checking ${UPDATE_FEED_URL}`);
      this.status.checking = true;
      this.status.error = null;
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-available", (info: UpdateInfo) => {
      console.log(
        `[UpdateService] ${info.version} available (running ${app.getVersion()}) — downloading`
      );
      this.notOfferedStrikes = 0;
      // Installing a superseded build would relaunch straight into another
      // "Relaunch to update"; the pill comes down until the replacement lands.
      if (
        this.status.downloaded &&
        this.downloadedVersion !== info.version &&
        !this.status.installing
      ) {
        this.dropDownloadedBuild(
          `${info.version} supersedes downloaded ${this.downloadedVersion ?? "build"}`
        );
      }

      this.status.checking = false;
      this.status.available = true;
      // The flag also keeps the periodic check from disturbing the transfer.
      if (!this.status.downloaded) this.status.downloading = true;
      this.status.updateInfo = { version: info.version };
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-not-available", (info: UpdateInfo) => {
      console.log(
        `[UpdateService] up to date on ${app.getVersion()} (feed offers ${info.version})`
      );
      this.status.checking = false;
      this.status.available = false;
      this.status.updateInfo = { version: info.version };
      // A build the feed stops offering is a pulled release: drop it. On the
      // second consecutive answer, since one stale CDN edge right after a
      // release must not discard a valid build.
      if (this.status.downloaded && !this.status.installing) {
        this.notOfferedStrikes += 1;
        if (this.notOfferedStrikes >= 2) {
          this.dropDownloadedBuild(
            `downloaded ${this.downloadedVersion ?? "build"} no longer offered — dropping it`
          );
        } else {
          console.log(
            `[UpdateService] downloaded ${this.downloadedVersion ?? "build"} not offered by this check — dropping it if that repeats`
          );
        }
      }
      this.emitStatusUpdate();
    });

    autoUpdater.on("error", (error) => {
      // electron-updater errors arrive with full HTTP headers stapled on.
      const fullMsg = error?.message ?? String(error);
      const shortMsg = fullMsg.split("\n")[0] || fullMsg;
      console.warn(`[UpdateService] Update error: ${shortMsg}`);
      this.status.checking = false;
      this.status.downloading = false;
      // A dead transfer has no progress; a kept figure reads as a live one.
      this.status.progress = null;
      this.status.error = shortMsg;
      this.emitStatusUpdate();
    });

    autoUpdater.on("download-progress", (progress) => {
      this.status.progress = {
        percent: progress.percent,
        bytesPerSecond: progress.bytesPerSecond,
        total: progress.total,
        transferred: progress.transferred,
      };
      this.emitStatusUpdate();
    });

    autoUpdater.on("update-downloaded", (info: UpdateInfo) => {
      console.log(`[UpdateService] ${info.version} downloaded — pill is up`);
      this.notOfferedStrikes = 0;
      this.status.downloading = false;
      this.status.downloaded = true;
      this.status.updateInfo = { version: info.version };
      this.downloadedVersion = info.version;
      this.setUpdaterHasPendingBuild(true);
      this.emitStatusUpdate();
      this.startAutoRestartPoll();
    });
  }

  /** The build on disk is not the one to install any more; forget it. */
  private dropDownloadedBuild(reason: string): void {
    console.log(`[UpdateService] ${reason}`);
    this.notOfferedStrikes = 0;
    this.status.downloaded = false;
    // A stale progress sample would render as a live download.
    this.status.progress = null;
    this.downloadedVersion = null;
    this.stopAutoRestartPoll();
    this.setUpdaterHasPendingBuild(false);
  }

  /**
   * With a build pending, autoDownload comes off so a re-check is one YAML
   * fetch rather than a re-hash and (macOS) re-stage. When the build is
   * dropped, install-on-quit comes off too, so quitting does not install a
   * build the status has withdrawn; best-effort where Squirrel already
   * staged it.
   */
  private setUpdaterHasPendingBuild(pending: boolean): void {
    autoUpdater.autoDownload = !pending;
    autoUpdater.autoInstallOnAppQuit = pending;
  }

  // Wait for a moment when a restart destroys nothing and take it silently;
  // the pill stays as the manual path.
  private startAutoRestartPoll(): void {
    if (this.autoRestartTimer != null) return;

    this.autoRestartTimer = setInterval(
      () => this.tryAutoRestart(),
      AUTO_RESTART_POLL_MS
    );
    this.autoRestartTimer.unref();
  }

  private stopAutoRestartPoll(): void {
    if (this.autoRestartTimer == null) return;
    clearInterval(this.autoRestartTimer);
    this.autoRestartTimer = null;
  }

  private tryAutoRestart(): void {
    if (
      !this.status.downloaded ||
      this.status.installing ||
      this.status.installStalled
    ) {
      return;
    }

    // Where idle time is unavailable (some Wayland setups report 0 forever)
    // this never fires and the pill carries the update.
    if (powerMonitor.getSystemIdleTime() < AUTO_RESTART_IDLE_SECONDS) return;

    if (this.deps.isSafeToRestart != null && !this.deps.isSafeToRestart()) {
      return;
    }

    // A hidden window can relaunch hidden on macOS (the dock reveals it);
    // elsewhere it would be unreachable, so leave those to install-on-quit.
    const windowVisible = BaseWindow.getAllWindows().some(
      (win) => !win.isDestroyed() && win.isVisible()
    );
    let relaunchHidden = false;
    if (!windowVisible) {
      if (process.platform !== "darwin") return;
      relaunchHidden = true;
    }

    console.log(
      `[UpdateService] ${this.status.updateInfo?.version ?? "update"} ready and the app is idle — restarting silently`
    );
    this.stopAutoRestartPoll();
    void this.installUpdate({ silent: true, relaunchHidden });
  }

  // Fails to "no change": metadata is an escalation channel, never a blocker.
  private async refreshReleaseMetadata(): Promise<void> {
    try {
      const res = await fetch(RELEASE_METADATA_URL, {
        signal: AbortSignal.timeout(RELEASE_METADATA_TIMEOUT_MS),
      });
      if (!res.ok) return;
      const meta: unknown = await res.json();
      const criticalBelow = (meta as { criticalBelow?: unknown })
        ?.criticalBelow;
      const critical =
        typeof criticalBelow === "string" &&
        versionLessThan(app.getVersion(), criticalBelow);
      if (critical !== this.status.criticalUpdate) {
        console.log(
          `[UpdateService] criticalBelow=${String(criticalBelow)} — critical: ${critical}`
        );
        this.status.criticalUpdate = critical;
        this.emitStatusUpdate();
      }
    } catch (err) {
      console.warn(
        `[UpdateService] release metadata fetch failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  async checkForUpdates(): Promise<{ success: boolean; error?: string }> {
    try {
      this.status.error = null;
      this.status.installStalled = false;
      this.emitStatusUpdate();

      void this.refreshReleaseMetadata();

      await autoUpdater.checkForUpdates();
      return { success: true };
    } catch (error) {
      const fullMsg = error instanceof Error ? error.message : String(error);
      const shortMsg = fullMsg.split("\n")[0] || fullMsg;
      console.warn(`[UpdateService] Failed to check for updates: ${shortMsg}`);
      this.status.error = shortMsg;
      this.status.checking = false;
      this.emitStatusUpdate();
      return { success: false, error: shortMsg };
    }
  }

  async installUpdate(options?: {
    /** Windows: run the NSIS installer with no UI. The auto path sets this. */
    silent?: boolean;
    /** macOS: the window was hidden at restart, so come back hidden. */
    relaunchHidden?: boolean;
  }): Promise<{ success: boolean; error?: string }> {
    try {
      if (!this.status.downloaded) {
        throw new Error("No update downloaded to install");
      }

      // A second ShipIt process makes the first abort on macOS.
      if (this.status.installing) {
        return { success: true };
      }
      this.status.installing = true;
      this.emitStatusUpdate();

      // Declare quit intent before handing off: Squirrel.Mac only closes the
      // windows, and the macOS 'close' handler hides unless a quit is underway.
      this.stopPeriodicChecks();
      this.stopAutoRestartPoll();
      markQuitting();
      if (options?.relaunchHidden) markRelaunchHidden();

      try {
        autoUpdater.quitAndInstall(options?.silent ?? false, true);
      } catch (err) {
        // No hand-off: drop the quit intent (else the next close terminates
        // instead of hiding) and resume the watchers.
        clearQuitting();
        if (options?.relaunchHidden) clearRelaunchHidden();
        if (app.isPackaged) this.startPeriodicChecks();
        this.startAutoRestartPoll();
        throw err;
      }
      this.startQuitWatchdog();
      return { success: true };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      console.error("[UpdateService] Failed to install update:", errorMessage);
      this.status.installing = false;
      this.emitStatusUpdate();
      return { success: false, error: errorMessage };
    }
  }

  // Backstop for an install that never quits: the installer applies on exit,
  // so escalate. Stage 1 keeps before-quit cleanup (the vm-helper would
  // otherwise collide with the relaunched app); stage 2 hard-exits.
  private startQuitWatchdog(): void {
    setTimeout(() => {
      console.warn(
        `[UpdateService] Still running ${QUIT_STALL_MS / 1000}s after install hand-off — forcing quit`
      );
      this.status.installStalled = true;
      this.emitStatusUpdate();
      try {
        app.quit();
      } catch (err) {
        console.warn(
          "[UpdateService] app.quit() during stalled install failed:",
          err
        );
      }
    }, QUIT_STALL_MS).unref();

    setTimeout(() => {
      console.warn(
        `[UpdateService] Still running ${QUIT_FORCE_MS / 1000}s after install hand-off — exiting`
      );
      app.exit(0);
    }, QUIT_FORCE_MS).unref();
  }

  getStatus(): UpdateStatus {
    return { ...this.status };
  }

  async checkForUpdatesOnStartup(): Promise<void> {
    if (!app.isPackaged) {
      console.log("[UpdateService] dev build — not checking for updates");
      return;
    }
    this.checkForUpdates();
    this.startPeriodicChecks();
  }

  // Keeps polling once a build is downloaded, so the pending install stays at
  // most one interval behind the feed.
  private startPeriodicChecks(): void {
    if (this.checkTimer != null) return;

    this.checkTimer = setInterval(() => {
      if (this.status.installing || this.status.downloading) return;

      this.checkForUpdates();
    }, UPDATE_CHECK_INTERVAL_MS);

    this.checkTimer.unref();
  }

  stopPeriodicChecks(): void {
    if (this.checkTimer == null) return;

    clearInterval(this.checkTimer);
    this.checkTimer = null;
  }

  private emitStatusUpdate(): void {
    sendToRenderer("update-status", this.status);
  }
}
