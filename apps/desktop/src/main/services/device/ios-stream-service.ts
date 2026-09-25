import { spawn, type ChildProcessByStdio } from "child_process";
import fs from "fs";
import type { Readable, Writable } from "stream";

import type { WebContents } from "electron";

import { DEVICE_STREAM_CHUNK_CHANNEL } from "./device-stream-service";
import {
  resolveSimInputHelperPath,
  resolveSimulatorDeveloperDir,
  ensureHelperRunnable,
} from "./sim-input-client";

/**
 * Headless framebuffer stream for a booted iOS simulator. The sim-input
 * helper (native/sim-input/video.m) reads CoreSimulator's display IOSurface
 * and writes one JSON status line, then [u32 BE length][JPEG bytes] frames.
 * Exact device pixels, so mirror taps map 1:1; ships as `mjpeg`.
 */

const STREAM_SCALE = "0.5"; // half device pixels: sharp, light to encode
const STREAM_FPS = "60"; // cap; frame-callback-driven, so idle costs nothing
const STREAM_QUALITY = "0.6";
const MAX_FRAME_BYTES = 16 * 1024 * 1024;
/** The helper waits ~10s for the first surface; allow a little longer. */
const READY_TIMEOUT_MS = 13_000;

export class IosStreamService {
  private proc: ChildProcessByStdio<Writable, Readable, Readable> | null = null;
  private wc: WebContents | null = null;
  private streamId = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private headerParsed = false;
  private frameCount = 0;
  private readyWaiter: ((line: string | null) => void) | null = null;
  /** Removed on stop(); otherwise once-listeners accumulate per start(). */
  private onWcDestroyed: (() => void) | null = null;

  isActive(): boolean {
    return this.proc != null;
  }

  async start(
    udid: string,
    wc: WebContents
  ): Promise<{ success: boolean; streamId?: number; error?: string }> {
    this.stop();
    const helper = resolveSimInputHelperPath();
    if (process.platform !== "darwin" || !fs.existsSync(helper)) {
      return { success: false, error: "iOS mirror helper unavailable." };
    }
    const developerDir = await resolveSimulatorDeveloperDir();
    if (developerDir == null)
      return { success: false, error: "Xcode developer dir not found." };

    this.wc = wc;
    this.streamId += 1;
    const currentId = this.streamId;
    this.buffer = Buffer.alloc(0);
    this.headerParsed = false;
    this.frameCount = 0;

    ensureHelperRunnable();
    const proc = spawn(
      helper,
      [udid, developerDir, "stream", STREAM_SCALE, STREAM_FPS, STREAM_QUALITY],
      {
        stdio: ["pipe", "pipe", "pipe"],
      }
    );
    this.proc = proc;
    const onDestroyed = (): void => {
      if (this.streamId === currentId) this.stop();
    };
    this.onWcDestroyed = onDestroyed;
    wc.once("destroyed", onDestroyed);

    proc.stdout.on("data", (chunk: Buffer) => {
      if (this.streamId !== currentId) return;
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drain(currentId);
    });
    // Without a reader the stderr buffer fills and the helper blocks.
    proc.stderr?.on("data", () => {});
    proc.on("exit", () => {
      this.readyWaiter?.(null);
      if (this.streamId === currentId) this.proc = null;
    });
    proc.on("error", () => {
      this.readyWaiter?.(null);
      if (this.streamId === currentId) this.stop();
    });

    // Wait for the helper's report so setup failures surface as structured
    // errors instead of a silent timeout.
    const statusLine = await new Promise<string | null>((resolve) => {
      this.readyWaiter = resolve;
      setTimeout(() => resolve(null), READY_TIMEOUT_MS);
    });
    this.readyWaiter = null;
    if (this.streamId !== currentId)
      return { success: false, error: "superseded" };
    if (statusLine == null) {
      this.stop();
      return { success: false, error: "mirror helper did not become ready" };
    }
    try {
      const status = JSON.parse(statusLine) as {
        ready?: boolean;
        ok?: boolean;
        error?: string;
      };
      if (status.ready !== true) {
        this.stop();
        return {
          success: false,
          error: status.error ?? "mirror failed to start",
        };
      }
    } catch {
      this.stop();
      return { success: false, error: "unparseable mirror status" };
    }
    return { success: true, streamId: currentId };
  }

  stop(): void {
    if (this.wc != null && this.onWcDestroyed != null) {
      try {
        this.wc.removeListener("destroyed", this.onWcDestroyed);
      } catch {
        /* already destroyed */
      }
    }
    this.onWcDestroyed = null;
    this.wc = null;
    this.readyWaiter?.(null);
    this.readyWaiter = null;
    if (this.proc != null) {
      try {
        this.proc.stdin.end();
      } catch {
        /* already closed */
      }
      try {
        this.proc.kill();
      } catch {
        /* already dead */
      }
      this.proc = null;
    }
    this.buffer = Buffer.alloc(0);
    this.headerParsed = false;
  }

  /** Parses the one-line JSON status, then length-prefixed JPEG frames. */
  private drain(streamId: number): void {
    if (!this.headerParsed) {
      const nl = this.buffer.indexOf(0x0a);
      if (nl < 0) return; // status line not complete yet
      const line = this.buffer.subarray(0, nl).toString("utf-8");
      this.buffer = this.buffer.subarray(nl + 1);
      this.headerParsed = true;
      this.readyWaiter?.(line);
    }
    for (;;) {
      if (this.buffer.length < 4) return;
      const len = this.buffer.readUInt32BE(0);
      if (len <= 0 || len > MAX_FRAME_BYTES) {
        this.stop();
        return;
      } // desync: bail
      if (this.buffer.length < 4 + len) return;
      const frame = this.buffer.subarray(4, 4 + len);
      this.emit(streamId, frame);
      this.buffer = this.buffer.subarray(4 + len);
    }
  }

  private emit(streamId: number, jpeg: Buffer): void {
    const wc = this.wc;
    if (wc == null || wc.isDestroyed()) return;
    this.frameCount += 1;
    try {
      wc.send(DEVICE_STREAM_CHUNK_CHANNEL, {
        streamId,
        data: jpeg,
        isKey: true,
        format: "mjpeg",
      });
    } catch {
      /* renderer teardown race */
    }
  }
}
