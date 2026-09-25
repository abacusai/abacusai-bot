/**
 * The scrcpy mirror runs entirely on events from a child process and two
 * sockets, so anything it leaves unhandled lands on the main process. These
 * cases drive the paths where that used to happen (a socket dropped while
 * connecting, adb failing to start, and a length prefix from the device that
 * no frame could have) against fakes, with no device involved.
 */
import { EventEmitter } from "events";
import os from "os";

import type { WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({
  app: { isPackaged: false, getPath: () => os.tmpdir(), getAppPath: () => "." },
}));

const spawned: FakeProcess[] = [];
const sockets: FakeSocket[] = [];

class FakeProcess extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = vi.fn();
}

class FakeSocket extends EventEmitter {
  destroyed = false;
  /** An error the socket surfaces on destroy(), the way a reset one does. */
  pendingError: Error | null = null;
  pause = vi.fn();
  resume = vi.fn();
  write = vi.fn(() => true);
  destroy(): void {
    this.destroyed = true;
    const err = this.pendingError;
    this.pendingError = null;
    if (err != null) this.emit("error", err);
  }
}

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  const execFile = (...args: unknown[]): unknown => {
    const done = args[args.length - 1];
    if (typeof done === "function") done(null, "", "");
    return new FakeProcess();
  };
  const spawn = (): FakeProcess => {
    const proc = new FakeProcess();
    spawned.push(proc);
    return proc;
  };
  return { ...actual, execFile, spawn };
});

vi.mock("net", async (importOriginal) => {
  const actual = await importOriginal<typeof import("net")>();
  const connect = (): FakeSocket => {
    const sock = new FakeSocket();
    sockets.push(sock);
    return sock;
  };
  return { ...actual, default: { ...actual, connect }, connect };
});

import { AndroidScrcpyService } from "./android-scrcpy-service";
import type { DeviceService } from "./device-service";

const deviceService = {
  getToolchain: () => ({ adbPath: "/usr/bin/adb" }),
} as unknown as DeviceService;

const webContents = {
  once: vi.fn(),
  removeListener: vi.fn(),
  isDestroyed: () => false,
  send: vi.fn(),
} as unknown as WebContents;

/** Waits for the service to open socket number `index`. */
async function socketAt(index: number): Promise<FakeSocket> {
  for (let i = 0; i < 200 && sockets.length <= index; i++) {
    await new Promise((r) => setImmediate(r));
  }
  if (sockets.length <= index) throw new Error(`socket ${index} never opened`);
  return sockets[index];
}

/** Starts the mirror and answers both sockets the way the device server does. */
async function startMirror(
  service: AndroidScrcpyService
): Promise<{ video: FakeSocket; server: FakeProcess }> {
  const started = service.start("emulator-5554", webContents);
  const video = await socketAt(0);
  video.emit("data", Buffer.from([0x00])); // server handshake byte
  const control = await socketAt(1);
  control.emit("connect");
  await started;
  return { video, server: spawned[0] };
}

describe("the scrcpy mirror", () => {
  beforeEach(() => {
    spawned.length = 0;
    sockets.length = 0;
    // The jar only has to exist; nothing here reads it.
    process.env.SCRCPY_SERVER_PATH = __filename;
  });

  afterEach(() => {
    delete process.env.SCRCPY_SERVER_PATH;
    vi.useRealTimers();
  });

  it("survives a socket that fails while it is still connecting", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    const service = new AndroidScrcpyService(deviceService);
    void service.start("emulator-5554", webContents);
    const video = await socketAt(0);
    video.pendingError = new Error("ECONNRESET");

    // The connect attempt gives up on a silent socket after 1.5s and retries.
    expect(() => vi.advanceTimersByTime(2000)).not.toThrow();
    expect(video.destroyed).toBe(true);
    service.stop();
  });

  it("survives adb failing to start", async () => {
    const service = new AndroidScrcpyService(deviceService);
    const { server } = await startMirror(service);
    expect(() => server.emit("error", new Error("EACCES"))).not.toThrow();
    service.stop();
  });

  it("survives the control socket failing while it is connecting", async () => {
    const service = new AndroidScrcpyService(deviceService);
    void service.start("emulator-5554", webContents);
    const video = await socketAt(0);
    video.emit("data", Buffer.from([0x00]));
    const control = await socketAt(1);
    control.pendingError = new Error("ECONNRESET");

    expect(() => control.emit("error", new Error("ECONNRESET"))).not.toThrow();
    expect(control.destroyed).toBe(true);
    service.stop();
  });

  it("gives up instead of buffering a frame size no frame has", async () => {
    const service = new AndroidScrcpyService(deviceService);
    const { video } = await startMirror(service);
    const restart = vi.fn();
    service.onUnexpectedExit = restart;

    const header = Buffer.alloc(12); // codec id + width + height
    video.emit("data", header);
    const frame = Buffer.alloc(12);
    frame.writeUInt32BE(0x7fff_ffff, 8); // payload size
    video.emit("data", frame);

    expect(service.isActive()).toBe(false);
    // A desync must reach the owner's restart path. A mirror that simply
    // stops leaves the panel frozen on its last frame.
    expect(restart).toHaveBeenCalledTimes(1);
  });

  it("keeps streaming a frame of an ordinary size", async () => {
    const service = new AndroidScrcpyService(deviceService);
    const { video } = await startMirror(service);

    video.emit("data", Buffer.alloc(12));
    const frame = Buffer.alloc(12 + 8);
    frame.writeUInt32BE(8, 8);
    video.emit("data", frame);

    expect(service.isActive()).toBe(true);
    expect(webContents.send).toHaveBeenCalled();
    service.stop();
  });
});
