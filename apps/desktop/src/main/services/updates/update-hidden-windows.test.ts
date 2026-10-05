import { EventEmitter } from "node:events";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

const autoUpdater = Object.assign(new EventEmitter(), {
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.82" },
  })),
  quitAndInstall: vi.fn(),
});
const markRelaunchHidden = vi.fn();

vi.mock("electron-updater", () => ({ default: { autoUpdater } }));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.81", isPackaged: false },
  BaseWindow: { getAllWindows: () => [] },
  powerMonitor: { getSystemIdleTime: () => 601 },
}));
vi.mock("../../app-quit-state", () => ({
  markQuitting: vi.fn(),
  clearQuitting: vi.fn(),
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden,
  clearRelaunchHidden: vi.fn(),
}));

const { UpdateService } = await import("./update-service");

beforeEach(() => {
  vi.useFakeTimers();
  autoUpdater.removeAllListeners();
  autoUpdater.quitAndInstall.mockClear();
  markRelaunchHidden.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("installs a downloaded update from a hidden Windows window", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("win32");
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(markRelaunchHidden).not.toHaveBeenCalled();
  expect(service.getStatus().installing).toBe(true);
});
