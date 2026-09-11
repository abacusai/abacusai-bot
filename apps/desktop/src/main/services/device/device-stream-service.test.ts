/**
 * The screenrecord fallback respawns itself after every exit, which is right
 * for the 3-minute segment limit and wrong for a device that has gone away:
 * that exits at once, every time. These cases pin the restart budget that
 * separates the two.
 */
import { EventEmitter } from "events";
import os from "os";

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir() },
}));

const spawned: FakeProcess[] = [];

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: vi.fn(() => {
      const proc = new FakeProcess();
      spawned.push(proc);
      return proc;
    }),
  };
});

import type { DeviceService } from "./device-service";
import {
  DeviceStreamService,
  MAX_SCREENRECORD_RESTARTS,
} from "./device-stream-service";

const deviceService = {
  getToolchain: () => ({ adbPath: "/usr/bin/adb" }),
} as unknown as DeviceService;

const webContents = {
  once: vi.fn(),
  removeListener: vi.fn(),
  isDestroyed: () => false,
  send: vi.fn(),
} as unknown as WebContents;

/** One complete H.264 access unit, enough for the service to emit a frame. */
function deliverFrame(): void {
  spawned[spawned.length - 1].stdout.emit(
    "data",
    Buffer.from([0, 0, 0, 1, 0x65, 0x01, 0, 0, 0, 1])
  );
}

/** Ends the newest segment and lets the restart timer fire. */
function endSegment(): void {
  spawned[spawned.length - 1].emit("exit");
  vi.advanceTimersByTime(1000);
}

describe("respawning the Android screenrecord stream", () => {
  beforeEach(() => {
    spawned.length = 0;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("stops respawning once the budget is spent", async () => {
    const service = new DeviceStreamService(deviceService);
    await service.start("emulator-5554", webContents);
    expect(spawned).toHaveLength(1);

    for (let i = 0; i < MAX_SCREENRECORD_RESTARTS + 3; i++) endSegment();

    expect(spawned).toHaveLength(1 + MAX_SCREENRECORD_RESTARTS);
    expect(service.isActive()).toBe(false);
  });

  it("does not hand the budget back for a single frame", async () => {
    const service = new DeviceStreamService(deviceService);
    await service.start("emulator-5554", webContents);

    // A device on its way out can still manage one frame per attempt.
    for (let i = 0; i < MAX_SCREENRECORD_RESTARTS + 3; i++) {
      deliverFrame();
      endSegment();
    }

    expect(spawned).toHaveLength(1 + MAX_SCREENRECORD_RESTARTS);
    expect(service.isActive()).toBe(false);
  });

  it("gives a fresh budget to a stream the user starts again", async () => {
    const service = new DeviceStreamService(deviceService);
    await service.start("emulator-5554", webContents);
    for (let i = 0; i < MAX_SCREENRECORD_RESTARTS + 1; i++) endSegment();
    const afterFirst = spawned.length;

    await service.start("emulator-5554", webContents);
    expect(spawned).toHaveLength(afterFirst + 1);
    expect(service.isActive()).toBe(true);
  });
});
