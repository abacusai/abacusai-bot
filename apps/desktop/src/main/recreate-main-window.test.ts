import { EventEmitter } from "node:events";

import { expect, it, vi } from "vitest";

import {
  mainWindowCloseAction,
  mainWindowLifecycle,
} from "./recreate-main-window";

it("does not quit a fake app when destroying the last window during recreation", async () => {
  const app = new EventEmitter();
  const quit = vi.fn();
  const state = { url: "app://renderer/#/workspace", visible: true };
  const window = { destroy: vi.fn(() => app.emit("window-all-closed")) };
  let finish!: () => void;
  const create = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      })
  );
  const lifecycle = mainWindowLifecycle({
    platform: "linux",
    quit,
    capture: () => state,
    destroy: () => window.destroy(),
    create,
  });
  app.on("window-all-closed", lifecycle.onWindowAllClosed);
  const recreate = lifecycle.recreateMainWindow();
  expect(lifecycle.recreatingMainWindow).toBe(true);
  expect(quit).not.toHaveBeenCalled();
  expect(create).toHaveBeenCalledWith(state);
  await lifecycle.recreateMainWindow();
  expect(window.destroy).toHaveBeenCalledOnce();
  app.emit("window-all-closed");
  expect(quit).not.toHaveBeenCalled();
  finish();
  await recreate;
  expect(lifecycle.recreatingMainWindow).toBe(false);
  app.emit("window-all-closed");
  expect(quit).toHaveBeenCalledOnce();
});

it("clears the guard if replacement creation rejects", async () => {
  const quit = vi.fn();
  const lifecycle = mainWindowLifecycle({
    platform: "win32",
    quit,
    capture: () => ({}),
    destroy: vi.fn(),
    create: async () => {
      throw new Error("create failed");
    },
  });
  await expect(lifecycle.recreateMainWindow()).rejects.toThrow("create failed");
  expect(lifecycle.recreatingMainWindow).toBe(false);
  lifecycle.onWindowAllClosed();
  expect(quit).toHaveBeenCalledOnce();
});

it("leaves an absent window alone and keeps macOS in the dock", async () => {
  const destroy = vi.fn();
  const quit = vi.fn();
  const lifecycle = mainWindowLifecycle({
    platform: "darwin",
    quit,
    capture: () => null,
    destroy,
    create: vi.fn(),
  });
  await lifecycle.recreateMainWindow();
  lifecycle.onWindowAllClosed();
  expect(destroy).not.toHaveBeenCalled();
  expect(quit).not.toHaveBeenCalled();
});

it("hides to the tray on first run off macOS, and a real quit always closes", () => {
  const close = (
    platform: string,
    overrides: Partial<Parameters<typeof mainWindowCloseAction>[0]> = {}
  ) =>
    mainWindowCloseAction({
      platform,
      quitting: false,
      firstRun: false,
      taskRunning: false,
      ...overrides,
    });
  expect(close("darwin")).toBe("hide");
  for (const platform of ["win32", "linux"]) {
    expect(close(platform)).toBe("close");
    expect(close(platform, { taskRunning: true })).toBe("ask");
    expect(close(platform, { firstRun: true })).toBe("tray");
    expect(close(platform, { firstRun: true, taskRunning: true })).toBe("tray");
    expect(close(platform, { firstRun: true, quitting: true })).toBe("close");
  }
  expect(close("darwin", { quitting: true })).toBe("close");
});
