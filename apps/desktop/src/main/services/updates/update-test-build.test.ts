/**
 * A test build (`1.0.85-test.75`) must not take updates from the stable feed.
 * Seen on 2026-09-30: the feed offered 1.0.85, which sorts above the
 * prerelease, the build downloaded it and Squirrel asked for a password to
 * install it over the tester's copy.
 */
import { EventEmitter } from "node:events";

import { beforeEach, describe, expect, it, vi } from "vitest";

const autoUpdater = new EventEmitter() as EventEmitter &
  Record<string, unknown>;
const checkForUpdates = vi.fn(async () => undefined);
autoUpdater.checkForUpdates = checkForUpdates;

vi.mock("electron-updater", () => ({
  default: { autoUpdater },
}));
const electron = vi.hoisted(() => ({ version: "1.0.85-test.75" }));
vi.mock("electron", () => ({
  app: {
    getVersion: () => electron.version,
    isPackaged: true,
    on: () => {},
    userAgentFallback: "",
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

const { UpdateService } = await import("./update-service");

beforeEach(() => {
  checkForUpdates.mockClear();
  autoUpdater.removeAllListeners();
});

describe("a test build", () => {
  it("never asks the feed, at startup or by hand", async () => {
    const service = new UpdateService();
    await service.checkForUpdatesOnStartup();
    const byHand = await service.checkForUpdates();

    expect(checkForUpdates).not.toHaveBeenCalled();
    expect(byHand.success).toBe(false);
  });

  it("is the version suffix, not the packaging, that decides", async () => {
    electron.version = "1.0.85";
    const service = new UpdateService();
    await service.checkForUpdates();

    expect(checkForUpdates).toHaveBeenCalledOnce();
    electron.version = "1.0.85-test.75";
  });
});
