/**
 * What the status says after a download dies.
 *
 * From a real log dump: `net::ERR_NETWORK_CHANGED` killed a transfer partway
 * through — moving between wifi and a VPN is enough — and the status kept the
 * last progress figure it had seen. The renderer draws its bar and its
 * percentage straight off that number, so the row sat at "41%" with a spinner
 * over it for hours, through two more failed attempts, until the app was
 * restarted. The download was dead the whole time.
 *
 * There is deliberately no retry machinery of our own to test here. A failed
 * download surfaces at once, the strip offers a manual retry, and the next
 * periodic check — ten minutes away at most — re-runs the download via
 * autoDownload. A bespoke backoff ladder used to live in the service, from
 * the era when the only other retry was a six-hourly check.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;

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

/** A service mid-download, at the percentage the dump reported. */
const downloading = (): InstanceType<typeof UpdateService> => {
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("download-progress", {
    percent: 41.7,
    bytesPerSecond: 1_000,
    total: 100,
    transferred: 41,
  });

  return service;
};

beforeEach(() => {
  autoUpdater.removeAllListeners();
});

describe("a transfer that dies partway", () => {
  it("calls itself a download in progress while the build is coming", () => {
    // autoDownload starts fetching the moment a build is offered; the flag
    // also keeps the periodic check from disturbing the transfer.
    expect(downloading().getStatus().downloading).toBe(true);
  });

  it("stops reporting the percentage it got to", () => {
    const service = downloading();
    expect(service.getStatus().progress?.percent).toBe(41.7);

    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));

    expect(service.getStatus().progress).toBeNull();
  });

  it("stops calling itself a download in progress", () => {
    const service = downloading();

    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));

    expect(service.getStatus().downloading).toBe(false);
    expect(service.getStatus().downloaded).toBe(false);
  });

  it("says what went wrong, in one line", () => {
    // electron-updater errors arrive with HTTP headers stapled to them.
    const service = downloading();

    autoUpdater.emit(
      "error",
      new Error("Could not verify signature\nheaders: a lot of them")
    );

    expect(service.getStatus().error).toBe("Could not verify signature");
  });

  it("keeps the update on offer, because the next check retries it", () => {
    const service = downloading();

    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));

    expect(service.getStatus().available).toBe(true);
    expect(service.getStatus().updateInfo?.version).toBe("1.0.19");
  });
});

describe("a transfer that finishes", () => {
  it("is not disturbed by the clearing above", () => {
    const service = downloading();

    autoUpdater.emit("update-downloaded", { version: "1.0.19" });

    expect(service.getStatus().downloaded).toBe(true);
    expect(service.getStatus().downloading).toBe(false);
    expect(service.getStatus().error).toBeNull();
  });

  it("clears a failure once the retried transfer lands", () => {
    const service = downloading();
    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));

    // The periodic check found the same build and autoDownload re-ran it.
    autoUpdater.emit("checking-for-update", undefined);
    autoUpdater.emit("update-available", { version: "1.0.19" });
    autoUpdater.emit("update-downloaded", { version: "1.0.19" });

    expect(service.getStatus().error).toBeNull();
    expect(service.getStatus().downloaded).toBe(true);
  });
});
