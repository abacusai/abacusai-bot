/**
 * R5-T27/T28 (main side), spec 05 §31.5 h: every failure path sets both
 * `error` and `failedPhase`, read from the state before the failure cleared
 * it; a new check clears both.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.18",
    isPackaged: false,
    on: () => {},
    quit: () => {},
    exit: () => {},
  },
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
vi.mock("#main/renderer-host", () => ({ sendToRenderer: () => {} }));
vi.mock("#main/rpc/emit", () => ({ emitBusChannel: () => {} }));

const { UpdateService, failedPhaseOf } = await import("./update-service");

beforeEach(() => {
  autoUpdater.removeAllListeners();
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => undefined;
  autoUpdater.quitAndInstall = () => {};
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

const downloaded = (): InstanceType<typeof UpdateService> => {
  const service = new UpdateService();
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });
  return service;
};

describe("UpdateStatus.failedPhase", () => {
  it("starts null", () => {
    expect(new UpdateService().getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });
  });

  it("an updater error while checking is a check failure", () => {
    const service = new UpdateService();
    autoUpdater.emit("checking-for-update");
    autoUpdater.emit("error", new Error("feed unreachable\nheaders…"));
    expect(service.getStatus()).toMatchObject({
      checking: false,
      error: "feed unreachable",
      failedPhase: "check",
    });
  });

  it("an updater error mid-download is a download failure", () => {
    const service = new UpdateService();
    autoUpdater.emit("update-available", { version: "1.0.19" });
    autoUpdater.emit("download-progress", {
      percent: 10,
      bytesPerSecond: 1,
      total: 10,
      transferred: 1,
    });
    autoUpdater.emit("error", new Error("net::ERR_NETWORK_CHANGED"));
    expect(service.getStatus()).toMatchObject({
      downloading: false,
      progress: null,
      error: "net::ERR_NETWORK_CHANGED",
      failedPhase: "download",
    });
  });

  it("an updater error after the install hand-off is an install failure", async () => {
    vi.useFakeTimers();
    try {
      const service = downloaded();
      await service.installUpdate();
      autoUpdater.emit("error", new Error("signature mismatch"));
      expect(service.getStatus()).toMatchObject({
        error: "signature mismatch",
        failedPhase: "install",
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("checkForUpdates's own failure is a check failure", async () => {
    autoUpdater.checkForUpdates = async () => {
      throw new Error("ENOTFOUND downloads.abacus.ai");
    };
    const service = new UpdateService();
    await expect(service.checkForUpdates()).resolves.toEqual({
      success: false,
      error: "ENOTFOUND downloads.abacus.ai",
    });
    expect(service.getStatus()).toMatchObject({
      error: "ENOTFOUND downloads.abacus.ai",
      failedPhase: "check",
    });
  });

  it("installUpdate's failure sets error and install (it used to set neither)", async () => {
    const service = new UpdateService();
    await expect(service.installUpdate()).resolves.toEqual({
      success: false,
      error: "No update downloaded to install",
    });
    expect(service.getStatus()).toMatchObject({
      installing: false,
      error: "No update downloaded to install",
      failedPhase: "install",
    });

    autoUpdater.quitAndInstall = () => {
      throw new Error("Squirrel refused");
    };
    const ready = downloaded();
    await ready.installUpdate();
    expect(ready.getStatus()).toMatchObject({
      installing: false,
      error: "Squirrel refused",
      failedPhase: "install",
    });
  });

  it("a new check clears both", async () => {
    const service = new UpdateService();
    autoUpdater.emit("error", new Error("boom"));
    expect(service.getStatus().failedPhase).toBe("check");
    await service.checkForUpdates();
    expect(service.getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });

    autoUpdater.emit("error", new Error("boom"));
    autoUpdater.emit("checking-for-update");
    expect(service.getStatus()).toMatchObject({
      error: null,
      failedPhase: null,
    });
  });

  it("failedPhaseOf reads the pre-error state", () => {
    expect(failedPhaseOf({ installing: true, downloading: false })).toBe(
      "install"
    );
    expect(failedPhaseOf({ installing: false, downloading: true })).toBe(
      "download"
    );
    expect(failedPhaseOf({ installing: false, downloading: false })).toBe(
      "check"
    );
  });
});
