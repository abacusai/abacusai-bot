/**
 * The iOS mirror listens on the renderer's WebContents so it can stop pushing
 * frames when the window goes away. Every start adds that listener, so every
 * stop has to take it back off, otherwise they pile up on a WebContents that
 * outlives many mirror sessions.
 */
import { EventEmitter } from "events";
import os from "os";

import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => "." },
}));

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  stdin = { end: vi.fn() };
  kill = vi.fn();
}

let helperProcess: FakeProcess;

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return {
    ...actual,
    spawn: () => {
      helperProcess = new FakeProcess();
      return helperProcess;
    },
  };
});

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  const existsSync = (): boolean => true;
  return { ...actual, default: { ...actual, existsSync }, existsSync };
});

vi.mock("./sim-input-client", () => ({
  resolveSimInputHelperPath: () => "/tmp/sim-input",
  resolveSimulatorDeveloperDir: async () => "/Applications/Xcode.app",
  ensureHelperRunnable: () => {},
}));

import { IosStreamService } from "./ios-stream-service";

const realPlatform = process.platform;

function fakeWebContents(): WebContents {
  return {
    once: vi.fn(),
    removeListener: vi.fn(),
    isDestroyed: () => false,
    send: vi.fn(),
  } as unknown as WebContents;
}

describe("the iOS mirror", () => {
  beforeEach(() => {
    Object.defineProperty(process, "platform", { value: "darwin" });
    return () => {
      Object.defineProperty(process, "platform", { value: realPlatform });
    };
  });

  it("takes its WebContents listener back off on stop", async () => {
    const service = new IosStreamService();
    const wc = fakeWebContents();

    const started = service.start("UDID-1", wc);
    // The helper announces itself before start() resolves.
    await new Promise((r) => setImmediate(r));
    helperProcess.stdout.emit("data", Buffer.from('{"ready":true}\n'));
    expect(await started).toMatchObject({ success: true });

    service.stop();

    const once = vi.mocked(wc.once);
    const removeListener = vi.mocked(wc.removeListener);
    expect(once).toHaveBeenCalledWith("destroyed", expect.any(Function));
    expect(removeListener).toHaveBeenCalledWith(
      "destroyed",
      once.mock.calls[0][1]
    );
  });
});
