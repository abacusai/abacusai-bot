/**
 * macOS: the install has Squirrel fetch and stage the build while the app
 * runs, and quits only once it is staged.
 */
import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;
// Squirrel.Mac as MacUpdater holds it.
const squirrel = new EventEmitter() as EventEmitter & {
  checkForUpdates: ReturnType<typeof vi.fn>;
};

vi.mock("electron-updater", () => ({
  default: { autoUpdater, DebUpdater: class {} },
}));
vi.mock("electron-store", () => ({
  default: class {
    get() {}
    set() {}
    delete() {}
  },
}));
const electron = vi.hoisted(() => ({
  quit: vi.fn(),
  exit: vi.fn(),
  idleSeconds: 0,
}));
vi.mock("electron", () => ({
  app: {
    getVersion: () => "1.0.18",
    isPackaged: false,
    on: () => {},
    quit: electron.quit,
    exit: electron.exit,
  },
  // A visible window: the idle restart then restarts on every platform.
  BaseWindow: {
    getAllWindows: () => [{ isDestroyed: () => false, isVisible: () => true }],
  },
  powerMonitor: {
    on: () => {},
    getSystemIdleTime: () => electron.idleSeconds,
  },
}));
const quitState = vi.hoisted(() => ({ quitting: false }));
vi.mock("../../app-quit-state", () => ({
  markQuitting: () => {
    quitState.quitting = true;
  },
  clearQuitting: () => {
    quitState.quitting = false;
  },
}));
vi.mock("./relaunch-hidden", () => ({
  markRelaunchHidden: () => {},
  clearRelaunchHidden: () => {},
}));
vi.mock("#main/rpc/emit", () => ({ emitBusChannel: () => {} }));

const { UpdateService } = await import("./update-service");

const quitAndInstall = vi.fn();

beforeEach(() => {
  vi.useFakeTimers();
  quitState.quitting = false;
  electron.idleSeconds = 0;
  electron.quit.mockClear();
  electron.exit.mockClear();
  quitAndInstall.mockClear();
  autoUpdater.removeAllListeners();
  squirrel.removeAllListeners();
  squirrel.checkForUpdates = vi.fn();
  // MacUpdater's constructor: Squirrel's errors are re-emitted as its own.
  squirrel.on("error", (error) => autoUpdater.emit("error", error));
  autoUpdater.nativeUpdater = squirrel;
  autoUpdater.setFeedURL = () => {};
  autoUpdater.checkForUpdates = async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.19" },
  });
  autoUpdater.quitAndInstall = quitAndInstall;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("offline"));
});

afterEach(() => {
  vi.useRealTimers();
});

const downloaded = (deps?: ConstructorParameters<typeof UpdateService>[0]) => {
  const service = new UpdateService(deps);
  autoUpdater.emit("update-available", { version: "1.0.19" });
  autoUpdater.emit("update-downloaded", { version: "1.0.19" });
  return service;
};

/** Past the admission check, into staging. */
const settle = () => vi.advanceTimersByTimeAsync(0);

const keptForRetry = {
  downloaded: true,
  installing: false,
  preparing: false,
  failedPhase: "install",
};

describe("macOS install staging", () => {
  it("quits only once Squirrel has staged the build", async () => {
    const service = downloaded();
    const result = service.installUpdate();
    await settle();
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      preparing: true,
      installing: false,
    });
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(quitState.quitting).toBe(false);

    squirrel.emit("update-downloaded");
    await expect(result).resolves.toEqual({ success: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
    expect(service.getStatus()).toMatchObject({
      preparing: false,
      installing: true,
    });
    expect(quitState.quitting).toBe(true);
    // The quit watchdog runs from the hand-off.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(electron.quit).toHaveBeenCalledTimes(1);
    expect(squirrel.listenerCount("update-downloaded")).toBe(0);
  });

  it("a staging timeout keeps the app and the build for a retry", async () => {
    const service = downloaded();
    const result = service.installUpdate();
    await settle();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await expect(result).resolves.toMatchObject({ success: false });
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(quitState.quitting).toBe(false);
    expect(service.getStatus()).toMatchObject(keptForRetry);
    expect(service.getStatus().error).toMatch(/prepare/);

    // Squirrel finishes late; the retry installs at once, no second fetch.
    squirrel.emit("update-downloaded");
    await settle();
    await expect(service.installUpdate()).resolves.toEqual({ success: true });
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a Squirrel error is an install failure that keeps the build", async () => {
    const service = downloaded();
    const result = service.installUpdate();
    await settle();
    squirrel.emit("error", new Error("signature invalid\nheaders…"));
    await expect(result).resolves.toMatchObject({ success: false });
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(quitState.quitting).toBe(false);
    expect(service.getStatus()).toMatchObject({
      ...keptForRetry,
      error: "Couldn't prepare the update: signature invalid",
    });
    expect(squirrel.listenerCount("error")).toBe(1);
  });

  it("installs asked for during staging join it", async () => {
    const service = downloaded();
    const first = service.installUpdate();
    await settle();
    const second = service.installUpdate({ whenSafe: true });
    const third = service.installUpdate({ silent: true });
    await settle();
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(1);

    squirrel.emit("update-downloaded");
    await Promise.all([first, second, third]);
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("a retry after a timeout joins Squirrel's running fetch", async () => {
    const service = downloaded();
    const first = service.installUpdate();
    await settle();
    await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
    await first;

    const retry = service.installUpdate();
    await settle();
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(1);
    squirrel.emit("update-downloaded");
    await expect(retry).resolves.toEqual({ success: true });
    expect(quitAndInstall).toHaveBeenCalledTimes(1);
  });

  it("the idle restart stands down when a task starts during staging", async () => {
    let busy = false;
    const service = downloaded({ isSafeToRestart: () => !busy });
    electron.idleSeconds = 11 * 60;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(1);
    expect(service.getStatus().preparing).toBe(true);

    busy = true;
    squirrel.emit("update-downloaded");
    await settle();
    expect(quitAndInstall).not.toHaveBeenCalled();
    expect(quitState.quitting).toBe(false);
    expect(service.getStatus()).toMatchObject({
      downloaded: true,
      preparing: false,
      installing: false,
      error: null,
    });
  });

  it("a dropped build forgets its staging", async () => {
    const service = downloaded();
    const result = service.installUpdate();
    await settle();
    // A newer release supersedes it mid-staging.
    autoUpdater.emit("update-available", { version: "1.0.20" });
    squirrel.emit("update-downloaded");
    await expect(result).resolves.toMatchObject({ success: false });
    expect(quitAndInstall).not.toHaveBeenCalled();

    autoUpdater.checkForUpdates = async () => ({
      isUpdateAvailable: true,
      updateInfo: { version: "1.0.20" },
    });
    autoUpdater.emit("update-downloaded", { version: "1.0.20" });
    void service.installUpdate();
    await settle();
    expect(squirrel.checkForUpdates).toHaveBeenCalledTimes(2);
    expect(quitAndInstall).not.toHaveBeenCalled();
  });
});
