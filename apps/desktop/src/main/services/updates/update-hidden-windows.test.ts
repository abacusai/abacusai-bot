import { EventEmitter } from "node:events";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = Object.assign(new EventEmitter(), {
  isRunningAsRoot: () => false,
  determineSudoCommand: () => deb.sudo,
  setFeedURL: vi.fn(),
  checkForUpdates: vi.fn(async () => ({
    isUpdateAvailable: true,
    updateInfo: { version: "1.0.82" },
  })),
  quitAndInstall: vi.fn(),
});
const markRelaunchHidden = vi.fn();
const windows = vi.hoisted(() => ({ visible: false, idleSeconds: 601 }));
const deb = vi.hoisted(() => ({ isDeb: false, sudo: "sudo" }));
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater,
    DebUpdater: class {
      static [Symbol.hasInstance]() {
        return deb.isDeb;
      }
    },
  },
}));
const store = vi.hoisted(() => new Map<string, unknown>());
vi.mock("electron-store", () => ({
  default: class {
    get(key: string) {
      return store.get(key);
    }
    set(key: string, value: unknown) {
      store.set(key, value);
    }
    delete(key: string) {
      store.delete(key);
    }
  },
}));
vi.mock("electron", () => ({
  app: { getVersion: () => "1.0.81", isPackaged: false },
  BaseWindow: {
    getAllWindows: () =>
      windows.visible
        ? [{ isDestroyed: () => false, isVisible: () => true }]
        : [],
  },
  powerMonitor: { getSystemIdleTime: () => windows.idleSeconds },
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
  windows.visible = false;
  windows.idleSeconds = 601;
  deb.isDeb = false;
  deb.sudo = "sudo";
  store.clear();
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

it.each(["win32", "linux"] as const)(
  "a window hidden into the %s tray restarts into its update hidden",
  async (platform) => {
    vi.spyOn(process, "platform", "get").mockReturnValue(platform);
    const service = new UpdateService({
      isSafeToRestart: () => true,
      trayShown: () => true,
    });
    autoUpdater.emit("update-downloaded", { version: "1.0.82" });

    await vi.advanceTimersByTimeAsync(60_000);

    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(markRelaunchHidden).toHaveBeenCalledTimes(1);
    expect(service.getStatus().installing).toBe(true);
  }
);

it("a hidden Linux window with no tray waits for the window or the quit", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  new UpdateService({ isSafeToRestart: () => true, trayShown: () => false });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
});

it("an idle Linux AppImage still restarts into its update", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  windows.visible = true;
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(service.getStatus().installing).toBe(true);
});

it("a hidden macOS window still restarts hidden", async () => {
  vi.spyOn(process, "platform", "get").mockReturnValue("darwin");
  new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", { version: "1.0.82" });

  await vi.advanceTimersByTimeAsync(60_000);

  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(markRelaunchHidden).toHaveBeenCalledTimes(1);
});

const idleDeb = async (sudo: string) => {
  vi.spyOn(process, "platform", "get").mockReturnValue("linux");
  windows.visible = true;
  deb.isDeb = true;
  deb.sudo = sudo;
  const service = new UpdateService({ isSafeToRestart: () => true });
  autoUpdater.emit("update-downloaded", {
    version: "1.0.82",
    downloadedFile: "/tmp/bot.deb",
  });
  await vi.advanceTimersByTimeAsync(60_000);
  return service;
};

it("an idle .deb with a graphical prompt restarts through electron-updater", async () => {
  const service = await idleDeb("pkexec");
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
  expect(service.getStatus().installing).toBe(true);
});

it("an idle .deb with only sudo never restarts by itself: it is a manual install", async () => {
  const service = await idleDeb("sudo");
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
  expect(service.getStatus()).toMatchObject({
    downloaded: true,
    installing: false,
    manualInstall: { packagePath: "/tmp/bot.deb" },
  });
});

it("an idle .deb whose install failed is not retried by the idle restart", async () => {
  autoUpdater.quitAndInstall.mockImplementationOnce(() => {
    autoUpdater.emit("error", new Error("Command pkexec exited with code 127"));
  });
  const service = await idleDeb("pkexec");
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(service.getStatus()).toMatchObject({
    installing: false,
    installStalled: false,
    manualInstall: { packagePath: "/tmp/bot.deb" },
  });
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  expect(service.getStatus().installStalled).toBe(false);
});

describe("a restart the user asks for while a task runs", () => {
  const turn = { running: true };
  const asked = vi.fn((context: { requested: boolean }) => {
    void context;
    return !turn.running;
  });
  const clickMidTurn = async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    windows.visible = true;
    // The user is at the keyboard: the unasked restart's idle rule never holds.
    windows.idleSeconds = 0;
    turn.running = true;
    asked.mockClear();
    const service = new UpdateService({ isSafeToRestart: asked });
    autoUpdater.emit("update-downloaded", { version: "1.0.82" });
    const result = await service.installUpdate({ whenSafe: true });
    return { service, result };
  };

  it("waits for the running turn, then installs when it ends", async () => {
    const { service, result } = await clickMidTurn();
    expect(result).toEqual({ success: true });
    expect(asked).toHaveBeenLastCalledWith({ requested: true });
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.getStatus()).toMatchObject({
      restartQueued: true,
      installing: false,
    });

    await vi.advanceTimersByTimeAsync(60_000);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();

    turn.running = false;
    await vi.advanceTimersByTimeAsync(2_000);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(service.getStatus()).toMatchObject({
      restartQueued: false,
      installing: true,
    });
  });

  it("installs once the wait reaches its cap", async () => {
    const { service } = await clickMidTurn();
    await vi.advanceTimersByTimeAsync(9 * 60_000);
    expect(autoUpdater.quitAndInstall).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(service.getStatus().installing).toBe(true);
  });

  it("installs at once when nothing is running", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("linux");
    windows.visible = true;
    windows.idleSeconds = 0;
    turn.running = false;
    const service = new UpdateService({ isSafeToRestart: asked });
    autoUpdater.emit("update-downloaded", { version: "1.0.82" });
    await expect(service.installUpdate({ whenSafe: true })).resolves.toEqual({
      success: true,
    });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(false, true);
    expect(service.getStatus()).toMatchObject({
      restartQueued: false,
      installing: true,
    });
  });

  it("a quit never waits, and takes over a queued restart", async () => {
    const { service } = await clickMidTurn();
    await expect(service.installUpdate({ silent: true })).resolves.toEqual({
      success: true,
    });
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledWith(true, true);
    expect(service.getStatus()).toMatchObject({
      restartQueued: false,
      installing: true,
    });
    // The queued wait is gone: no second hand-off.
    await vi.advanceTimersByTimeAsync(5_000);
    expect(autoUpdater.quitAndInstall).toHaveBeenCalledTimes(1);
  });
});
