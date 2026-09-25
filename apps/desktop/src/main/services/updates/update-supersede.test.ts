/**
 * What happens to a downloaded build when the feed moves on.
 *
 * From the field: a window left open for twenty hours across twenty releases.
 * The first release downloaded, the pill went up, and the periodic check then
 * skipped itself for as long as `downloaded` was true, so clicking "Relaunch
 * to update" at hour twenty installed the build from hour zero, and the
 * relaunched app immediately put the pill up again for everything it missed.
 * Checks now run through the downloaded state, and these tests pin down what
 * each possible answer does to the build on disk.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const checkForUpdates = vi.fn(() => Promise.resolve(null));
const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;
autoUpdater.checkForUpdates = checkForUpdates;

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.18", isPackaged: false, on: () => {} },
  BaseWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
}));
vi.mock("../../app-quit-state", () => ({
  markQuitting: () => {},
  clearQuitting: () => {},
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden: () => {},
  clearRelaunchHidden: () => {},
}));

const { UpdateService } = await import("./update-service");

/** A service with 1.0.19 fully downloaded. The pill is up. */
const withDownloadedBuild = (): InstanceType<typeof UpdateService> => {
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("download-progress", {
    percent: 100,
    bytesPerSecond: 0,
    total: 100,
    transferred: 100,
  });
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });

  return service;
};

beforeEach(() => {
  autoUpdater.removeAllListeners();
  checkForUpdates.mockClear();
  // electron-updater's constructor defaults; the service toggles them.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("a check that finds a newer build than the one on disk", () => {
  it("supersedes the stale build rather than offering to install it", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });

    // The pill for 1.0.19 is down: installing it now would just relaunch into
    // another "Relaunch to update".
    expect(service.getStatus().downloaded).toBe(false);
    expect(service.getStatus().updateInfo?.version).toBe("1.0.20");
    // The finished transfer's 100% sample must not render as live progress.
    expect(service.getStatus().progress).toBeNull();
  });

  it("puts the pill back up once the replacement lands", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });
    autoUpdater.emit("update-downloaded", { version: "1.0.20" });

    const status = service.getStatus();
    expect(status.downloaded).toBe(true);
    expect(status.updateInfo?.version).toBe("1.0.20");
  });
});

describe("a check that finds the same build again", () => {
  it("keeps the pill up, undisturbed", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.19" });

    expect(service.getStatus().downloaded).toBe(true);
    expect(service.getStatus().updateInfo?.version).toBe("1.0.19");
    // The build is already on disk. A cache re-check is not a new download.
    expect(service.getStatus().downloading).toBe(false);
  });
});

describe("a check the pill must survive", () => {
  it("does not blink the pill off while the check runs", async () => {
    const service = withDownloadedBuild();

    const pending = service.checkForUpdates();

    // Mid-check: the build on disk is still real and still installable.
    expect(service.getStatus().downloaded).toBe(true);
    expect(service.getStatus().available).toBe(true);
    await pending;
  });
});

describe("a feed that no longer offers the downloaded build", () => {
  it("forgives a single stale answer: one CDN edge can lag another", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("drops the pulled release on the second consecutive answer", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });
    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(false);
    expect(service.getStatus().available).toBe(false);
    // Install-on-quit must not apply a build the feed retracted.
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);
  });

  it("does not let a lone stale answer between good ones accumulate", () => {
    const service = withDownloadedBuild();

    autoUpdater.emit("update-not-available", { version: "1.0.18" });
    autoUpdater.emit("update-available", { version: "1.0.19" });
    autoUpdater.emit("update-not-available", { version: "1.0.18" });

    expect(service.getStatus().downloaded).toBe(true);
  });
});

describe("electron-updater's switches, kept in step with the pending build", () => {
  it("stops auto-downloading once a build is on disk", () => {
    // Left on, every same-version re-check would re-hash the cached archive
    // and re-stage it. The check must be one YAML fetch.
    withDownloadedBuild();

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });

  it("resumes downloading, and parks install-on-quit, when superseded", () => {
    withDownloadedBuild();

    autoUpdater.emit("update-available", { version: "1.0.20" });

    expect(autoUpdater.autoDownload).toBe(true);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(false);

    autoUpdater.emit("update-downloaded", { version: "1.0.20" });

    expect(autoUpdater.autoDownload).toBe(false);
    expect(autoUpdater.autoInstallOnAppQuit).toBe(true);
  });
});
