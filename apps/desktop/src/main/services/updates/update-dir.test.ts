import { EventEmitter } from "node:events";
import { join } from "node:path";

import { afterEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  exists: vi.fn(() => false),
  check: vi.fn(),
  packaged: true,
}));
vi.mock("node:fs", () => ({ existsSync: mocks.exists }));
vi.mock("electron", () => ({
  app: {
    get isPackaged() {
      return mocks.packaged;
    },
    getVersion: () => "1.0.12",
  },
  BaseWindow: { getAllWindows: () => [] },
  powerMonitor: { on: () => {}, getSystemIdleTime: () => 0 },
}));
const updater = new EventEmitter();
vi.mock("electron-updater", () => ({
  default: {
    autoUpdater: Object.assign(updater, {
      setFeedURL: () => {},
      checkForUpdates: mocks.check,
    }),
  },
}));
const { UpdateService } = await import("./update-service");
afterEach(() => {
  updater.removeAllListeners();
  vi.restoreAllMocks();
});

it("skips a packaged dir distribution without updater configuration and logs the reason", async () => {
  vi.stubGlobal("process", {
    ...process,
    resourcesPath: "/synthetic/resources",
  });
  const log = vi.spyOn(console, "log").mockImplementation(() => {});
  const service = new UpdateService();
  await expect(service.checkForUpdates()).resolves.toEqual({ success: true });
  expect(mocks.exists).toHaveBeenCalledWith(
    join("/synthetic/resources", "app-update.yml")
  );
  expect(mocks.check).not.toHaveBeenCalled();
  expect(log).toHaveBeenCalledWith(
    expect.stringContaining("app-update.yml absent; updates disabled")
  );
  expect(service.getStatus().error).toBeNull();
  vi.unstubAllGlobals();
});

it("observes a rejected automatic download after the feed check resolves", async () => {
  vi.stubGlobal("process", {
    ...process,
    resourcesPath: "/synthetic/resources",
  });
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 404 }))
  );
  mocks.exists.mockReturnValue(true);
  const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  mocks.check.mockResolvedValue({
    cancellationToken: { cancel: () => {} },
    downloadPromise: Promise.reject(new Error("synthetic transfer failure")),
  });
  await expect(new UpdateService().checkForUpdates()).resolves.toEqual({
    success: true,
  });
  await Promise.resolve();
  expect(warn).toHaveBeenCalledWith(
    "[UpdateService] Download did not complete: synthetic transfer failure"
  );
  vi.unstubAllGlobals();
});
