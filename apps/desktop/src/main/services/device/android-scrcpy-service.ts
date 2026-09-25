import { spawn, execFile, type ChildProcess } from "child_process";
import fs from "fs";
import net from "net";

import type { WebContents } from "electron";

import { resourcePath } from "#main/resources";

import type { DeviceService } from "./device-service";
import { DEVICE_STREAM_CHUNK_CHANNEL } from "./device-stream-service";

/**
 * Headless Android screen stream + input via the scrcpy server (Apache-2.0,
 * github.com/Genymobile/scrcpy); `adb screenrecord` buffers for seconds.
 * Protocol (2.7): VIDEO socket first, then CONTROL; a 12-byte codec header,
 * then [u64 pts+flags][u32 size][payload] with bit 63 = config, 62 = key.
 */

const SCRCPY_VERSION = "2.7";
const DEVICE_JAR_PATH = "/data/local/tmp/scrcpy-server.jar";
const MAX_SIZE = 1024;
/**
 * 4 Mbit, not 8: at 1024/60fps both deliver the same frame gap, and the extra
 * bytes only cost renderer decode work.
 */
const VIDEO_BIT_RATE = 4_000_000;
const MAX_FPS = 60;
const CONNECT_TIMEOUT_MS = 15_000;
/** Larger than any access unit at the bit rate above; past it, desynced. */
const MAX_FRAME_BYTES = 4 * 1024 * 1024;

/** Android MotionEvent actions. */
const ACTION_DOWN = 0;
const ACTION_UP = 1;
const ACTION_MOVE = 2;

export const resolveScrcpyServerPath = (): string => {
  if (process.env.SCRCPY_SERVER_PATH != null)
    return process.env.SCRCPY_SERVER_PATH;
  return resourcePath("vendor", "scrcpy-server.jar");
};

export class AndroidScrcpyService {
  private server: ChildProcess | null = null;
  private video: net.Socket | null = null;
  private control: net.Socket | null = null;
  private wc: WebContents | null = null;
  private streamId = 0;
  private serial: string | null = null;
  private localPort: number | null = null;
  private buffer: Buffer = Buffer.alloc(0);
  private headerParsed = false;
  /** SPS/PPS from the config packet, prepended to the next keyframe. */
  private codecConfig: Buffer | null = null;
  private frameCount = 0;
  /** Set by stop() so the exit handler can tell a kill from a crash. */
  private stopReason: string | null = null;
  onUnexpectedExit: ((streamId: number) => void) | null = null;
  /** From the stream header; touch coords are sent in it. */
  private videoSize: { width: number; height: number } | null = null;
  /** Removed on stop(); otherwise once-listeners accumulate per start(). */
  private onWcDestroyed: (() => void) | null = null;

  constructor(private readonly deviceService: DeviceService) {}

  isActive(): boolean {
    return this.server != null;
  }

  private adb(): string | null {
    return this.deviceService.getToolchain().adbPath;
  }

  private run(
    adbPath: string,
    args: string[],
    timeoutMs = 15_000
  ): Promise<string> {
    return new Promise((resolve, reject) => {
      execFile(adbPath, args, { timeout: timeoutMs }, (err, stdout) => {
        if (err != null) reject(err);
        else resolve(stdout);
      });
    });
  }

  async start(
    serial: string,
    wc: WebContents
  ): Promise<{ success: boolean; streamId?: number; error?: string }> {
    this.stop("superseded by a new start()");
    this.stopReason = null;
    const adbPath = this.adb();
    if (adbPath == null) return { success: false, error: "adb not found." };
    const jar = resolveScrcpyServerPath();
    if (!fs.existsSync(jar)) {
      return {
        success: false,
        error:
          "scrcpy server not bundled. Run `pnpm --filter @abacus-ai/desktop vendor`.",
      };
    }

    this.serial = serial;
    this.wc = wc;
    this.streamId += 1;
    const currentId = this.streamId;
    this.buffer = Buffer.alloc(0);
    this.headerParsed = false;
    this.codecConfig = null;
    this.frameCount = 0;

    try {
      // The server deletes its own jar on exit, so push every time.
      await this.run(adbPath, ["-s", serial, "push", jar, DEVICE_JAR_PATH]);

      const scid = Math.floor(Math.random() * 0x7fffffff)
        .toString(16)
        .padStart(8, "0");
      const port = await freePort();
      this.localPort = port;
      await this.run(adbPath, [
        "-s",
        serial,
        "forward",
        `tcp:${port}`,
        `localabstract:scrcpy_${scid}`,
      ]);

      // send_frame_meta gives exact access-unit boundaries and keyframe flags,
      // which WebCodecs needs. send_dummy_byte is the handshake that tells the
      // real video socket from a premature adb-accepted one.
      const args = [
        `scid=${scid}`,
        "tunnel_forward=true",
        "audio=false",
        "control=true",
        "cleanup=true",
        "send_device_meta=false",
        "send_frame_meta=true",
        "send_codec_meta=true",
        "send_dummy_byte=true",
        `max_size=${MAX_SIZE}`,
        `video_bit_rate=${VIDEO_BIT_RATE}`,
        `max_fps=${MAX_FPS}`,
      ];
      this.server = spawn(
        adbPath,
        [
          "-s",
          serial,
          "shell",
          `CLASSPATH=${DEVICE_JAR_PATH} app_process / com.genymobile.scrcpy.Server ${SCRCPY_VERSION} ${args.join(" ")}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] }
      );
      // Without a reader the pipe buffers fill and scrcpy blocks.
      this.server.stdout?.on("data", () => {});
      this.server.stderr?.on("data", () => {});
      // A spawn failure arrives as an event; unhandled it takes down main.
      this.server.on("error", (err) => {
        console.warn(`[scrcpy] could not run adb: ${err.message}`);
        if (this.streamId === currentId) this.server = null;
      });
      this.server.on("exit", (code) => {
        // An unexplained exit means the device-side server crashed and the
        // mirror restarts, which reads as a freeze unless the reason is logged.
        const unexpected = this.stopReason == null;
        const why = this.stopReason ?? "UNEXPECTED: server died on its own";
        console.warn(`[scrcpy] server exited (code ${String(code)}): ${why}`);
        if (this.streamId === currentId) {
          this.server = null;
          // Without a restart the panel freezes on its last frame forever.
          if (unexpected) this.onUnexpectedExit?.(currentId);
        }
      });

      // Video first (confirmed by the handshake byte), then control. The
      // socket comes back paused: bytes delivered before our 'data' handler
      // is attached would be lost, and losing the codec header desyncs it.
      const { socket: videoSock, rest } = await connectVideoSocket(
        port,
        CONNECT_TIMEOUT_MS
      );
      // Superseded while connecting: assigning this socket to this.video
      // would clobber the newer stream's reference.
      if (this.streamId !== currentId) {
        // The socket has no error listener, and destroy() can surface a
        // pending error; unhandled, that is fatal to the main process.
        videoSock.on("error", () => {
          /* teardown races */
        });
        videoSock.destroy();
        return { success: false, error: "superseded" };
      }
      this.video = videoSock;

      videoSock.on("data", (chunk: Buffer) => {
        if (this.streamId !== currentId) return;
        this.buffer =
          this.buffer.length === 0
            ? chunk
            : Buffer.concat([this.buffer, chunk]);
        this.drain(currentId);
      });
      videoSock.on("error", () => {
        /* teardown races */
      });
      if (rest.length > 0) {
        this.buffer = rest;
        this.drain(currentId);
      }
      videoSock.resume();

      const controlSock = await connectWithRetry(port, CONNECT_TIMEOUT_MS);
      // Superseded: a newer start() owns the service now, and stop() would
      // kill its stream, so only destroy what this start connected.
      if (this.streamId !== currentId) {
        controlSock.destroy();
        videoSock.destroy();
        return { success: false, error: "superseded" };
      }
      this.control = controlSock;
      this.control.on("error", () => {
        /* teardown races */
      });
      const onDestroyed = (): void => {
        if (this.streamId === currentId) this.stop();
      };
      this.onWcDestroyed = onDestroyed;
      wc.once("destroyed", onDestroyed);

      return { success: true, streamId: currentId };
    } catch (err) {
      // A failing start can sit in connectVideoSocket for the full timeout, by
      // which time a newer start may be streaming; an unguarded stop() would
      // kill it.
      if (this.streamId === currentId)
        this.stop(
          `start failed: ${err instanceof Error ? err.message : String(err)}`
        );
      return {
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  stop(reason = "stop() called"): void {
    this.stopReason = reason;
    if (this.wc != null && this.onWcDestroyed != null) {
      try {
        this.wc.removeListener("destroyed", this.onWcDestroyed);
      } catch {
        /* already destroyed */
      }
    }
    this.onWcDestroyed = null;
    this.wc = null;
    for (const sock of [this.video, this.control]) {
      try {
        sock?.destroy();
      } catch {
        /* already gone */
      }
    }
    this.video = null;
    this.control = null;
    if (this.server != null) {
      try {
        this.server.kill();
      } catch {
        /* already dead */
      }
      this.server = null;
    }
    const adbPath = this.adb();
    if (adbPath != null && this.serial != null && this.localPort != null) {
      execFile(
        adbPath,
        ["-s", this.serial, "forward", "--remove", `tcp:${this.localPort}`],
        () => {
          /* best effort */
        }
      );
    }
    this.localPort = null;
    this.serial = null;
    this.buffer = Buffer.alloc(0);
    this.videoSize = null;
  }

  /** Parses the codec header, then length-prefixed H.264 access units. */
  private drain(streamId: number): void {
    if (!this.headerParsed) {
      if (this.buffer.length < 12) return;
      // Bytes 0-3 name the codec.
      const width = this.buffer.readUInt32BE(4);
      const height = this.buffer.readUInt32BE(8);
      this.buffer = this.buffer.subarray(12);
      this.headerParsed = true;
      this.videoSize = { width, height };
    }
    for (;;) {
      if (this.buffer.length < 12) return;
      const flagsHi = this.buffer.readUInt32BE(0);
      const size = this.buffer.readUInt32BE(8);
      // A desynced stream reports sizes no frame has, and waiting for them
      // grows memory without limit. Tear down through the owner's restart
      // path rather than leave the panel frozen.
      if (size > MAX_FRAME_BYTES) {
        this.stop(`frame size ${size} exceeds the maximum, stream desynced`);
        this.onUnexpectedExit?.(streamId);
        return;
      }
      if (this.buffer.length < 12 + size) return;
      const payload = this.buffer.subarray(12, 12 + size);
      this.buffer = this.buffer.subarray(12 + size);
      const isConfig = (flagsHi & 0x8000_0000) !== 0;
      const isKey = (flagsHi & 0x4000_0000) !== 0;
      if (isConfig) {
        // SPS/PPS: prefix the next keyframe so the decoder can configure.
        this.codecConfig = Buffer.from(payload);
        continue;
      }
      let au = payload;
      if (isKey && this.codecConfig != null) {
        au = Buffer.concat([this.codecConfig, payload]);
      }
      this.emit(streamId, au, isKey);
    }
  }

  private emit(streamId: number, data: Buffer, isKey: boolean): void {
    const wc = this.wc;
    if (wc == null || wc.isDestroyed()) return;
    this.frameCount += 1;
    try {
      wc.send(DEVICE_STREAM_CHUNK_CHANNEL, {
        streamId,
        data,
        isKey,
        format: "h264",
      });
    } catch {
      /* renderer teardown race */
    }
  }

  /** Inject a touch at normalized (0..1) coordinates. Fire-and-forget. */
  touch(phase: "down" | "move" | "up", nx: number, ny: number): boolean {
    const sock = this.control;
    const size = this.videoSize;
    if (sock == null || size == null) return false;
    const action =
      phase === "down" ? ACTION_DOWN : phase === "up" ? ACTION_UP : ACTION_MOVE;
    const x = Math.max(
      0,
      Math.min(size.width - 1, Math.round(nx * size.width))
    );
    const y = Math.max(
      0,
      Math.min(size.height - 1, Math.round(ny * size.height))
    );

    const msg = Buffer.alloc(32);
    let o = 0;
    msg.writeUInt8(2, o);
    o += 1; // TYPE_INJECT_TOUCH_EVENT
    msg.writeUInt8(action, o);
    o += 1;
    msg.writeBigInt64BE(-1n, o);
    o += 8; // pointerId (-1 = virtual finger)
    msg.writeInt32BE(x, o);
    o += 4;
    msg.writeInt32BE(y, o);
    o += 4;
    msg.writeUInt16BE(size.width, o);
    o += 2;
    msg.writeUInt16BE(size.height, o);
    o += 2;
    msg.writeUInt16BE(phase === "up" ? 0 : 0xffff, o);
    o += 2; // pressure
    msg.writeUInt32BE(0, o);
    o += 4; // actionButton
    msg.writeUInt32BE(phase === "up" ? 0 : 1, o); // buttons (PRIMARY while down)
    try {
      sock.write(msg);
      return true;
    } catch {
      return false;
    }
  }

  /** Android KEYCODE_* with optional meta state. */
  key(keycode: number, metaState = 0): boolean {
    const sock = this.control;
    if (sock == null) return false;
    const send = (action: number): void => {
      const msg = Buffer.alloc(14);
      msg.writeUInt8(0, 0); // TYPE_INJECT_KEYCODE
      msg.writeUInt8(action, 1); // 0 down / 1 up
      msg.writeInt32BE(keycode, 2);
      msg.writeUInt32BE(0, 6); // repeat
      msg.writeUInt32BE(metaState, 10);
      sock.write(msg);
    };
    try {
      send(0);
      send(1);
      return true;
    } catch {
      return false;
    }
  }

  text(value: string): boolean {
    const sock = this.control;
    if (sock == null || value === "") return false;
    const bytes = Buffer.from(value, "utf-8");
    const msg = Buffer.alloc(5 + bytes.length);
    msg.writeUInt8(1, 0); // TYPE_INJECT_TEXT
    msg.writeUInt32BE(bytes.length, 1);
    bytes.copy(msg, 5);
    try {
      sock.write(msg);
      return true;
    } catch {
      return false;
    }
  }
}

/** Ask the OS for an unused localhost port. */
const freePort = (): Promise<number> =>
  new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr != null ? addr.port : 0;
      srv.close(() =>
        port > 0 ? resolve(port) : reject(new Error("no free port"))
      );
    });
  });

/**
 * Connects the VIDEO socket and proves it is the real one by waiting for the
 * 1-byte handshake; a silent connect is a premature adb accept and is retried.
 * Returns any stream bytes that arrived with the handshake.
 */
const connectVideoSocket = (
  port: number,
  timeoutMs: number
): Promise<{ socket: net.Socket; rest: Buffer }> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      const sock = net.connect(port, "127.0.0.1");
      let settled = false;
      const retry = (): void => {
        if (settled) return;
        settled = true;
        sock.removeAllListeners();
        // removeAllListeners took the error handler; destroy() can surface a
        // pending error, fatal to the main process if unhandled.
        sock.on("error", () => {
          /* teardown races */
        });
        sock.destroy();
        if (Date.now() >= deadline)
          reject(new Error("scrcpy server never sent its handshake"));
        else setTimeout(attempt, 150);
      };
      sock.once("data", (chunk: Buffer) => {
        if (settled) return;
        settled = true;
        sock.removeAllListeners("close");
        sock.removeAllListeners("error");
        // Flowing mode now; removing the listener does not stop delivery, so
        // pause until the caller has wired its own handler.
        sock.pause();
        resolve({ socket: sock, rest: chunk.subarray(1) });
      });
      sock.once("close", retry);
      sock.once("error", retry);
      setTimeout(retry, 1500); // connected but silent → not the server
    };
    attempt();
  });

/** The forward exists immediately but the server needs a moment to listen. */
const connectWithRetry = (
  port: number,
  timeoutMs: number
): Promise<net.Socket> =>
  new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs;
    const attempt = (): void => {
      const sock = net.connect(port, "127.0.0.1");
      let settled = false;
      sock.once("connect", () => {
        settled = true;
        resolve(sock);
      });
      sock.once("error", () => {
        // A late error on a socket already handed out belongs to the caller;
        // retrying would open a second, orphaned connection.
        if (settled) return;
        settled = true;
        // destroy() can surface another error, fatal if unhandled.
        sock.on("error", () => {
          /* teardown races */
        });
        sock.destroy();
        if (Date.now() >= deadline)
          reject(new Error("scrcpy server did not accept a connection"));
        else setTimeout(attempt, 150);
      });
    };
    attempt();
  });
