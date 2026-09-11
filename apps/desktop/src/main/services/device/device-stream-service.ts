import { spawn, type ChildProcessByStdio } from "child_process";
import type { Readable } from "stream";

import type { WebContents } from "electron";

import type { DeviceService } from "./device-service";

/**
 * H.264 screen stream for Android via `adb exec-out screenrecord`, repackaged
 * from Annex-B into per-frame access units for the renderer's WebCodecs
 * decoder. screenrecord hard-stops at 3 minutes, so the service respawns it;
 * each segment re-emits SPS/PPS so the decoder can reconfigure.
 */

export const DEVICE_STREAM_CHUNK_CHANNEL = "agent:device-stream-chunk";

/**
 * Respawns allowed inside RESTART_WINDOW_MS; honest 3-minute rollovers never
 * come near it, a vanished device would otherwise loop forever. Per window
 * rather than consecutive, or a stream that manages one frame before dying
 * would hand the budget back forever.
 */
export const MAX_SCREENRECORD_RESTARTS = 3;
export const RESTART_WINDOW_MS = 60_000;
const RESTART_DELAY_MS = 150;

export interface DeviceStreamChunkPayload {
  streamId: number;
  /** One Annex-B access unit; keyframes are prefixed with SPS/PPS. */
  data: Uint8Array;
  isKey: boolean;
}

export class DeviceStreamService {
  private proc: ChildProcessByStdio<null, Readable, Readable> | null = null;
  private target: { serial: string } | null = null;
  private wc: WebContents | null = null;
  private streamId = 0;
  private buffer: Buffer = Buffer.alloc(0);
  private sps: Buffer | null = null;
  private pps: Buffer | null = null;
  private pendingNonVcl: Buffer[] = [];
  private restartTimer: NodeJS.Timeout | null = null;
  private emitted = 0;
  private restartTimes: number[] = [];
  /** Removed on stop(); otherwise once-listeners accumulate per start(). */
  private onWcDestroyed: (() => void) | null = null;

  constructor(private readonly deviceService: DeviceService) {}

  isActive(): boolean {
    return this.target != null;
  }

  async start(
    serial: string,
    wc: WebContents
  ): Promise<{ success: boolean; streamId?: number; error?: string }> {
    this.stop();
    const adbPath = this.deviceService.getToolchain().adbPath;
    if (adbPath == null) return { success: false, error: "adb not found." };
    this.target = { serial };
    this.wc = wc;
    this.emitted = 0;
    this.restartTimes = [];
    this.streamId += 1;
    const currentId = this.streamId;
    const onDestroyed = (): void => {
      if (this.streamId === currentId) this.stop();
    };
    this.onWcDestroyed = onDestroyed;
    wc.once("destroyed", onDestroyed);
    this.spawnSegment(adbPath, serial, currentId);
    return { success: true, streamId: currentId };
  }

  stop(): void {
    this.target = null;
    if (this.wc != null && this.onWcDestroyed != null) {
      try {
        this.wc.removeListener("destroyed", this.onWcDestroyed);
      } catch {
        /* already destroyed */
      }
    }
    this.onWcDestroyed = null;
    this.wc = null;
    if (this.restartTimer != null) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    if (this.proc != null) {
      try {
        this.proc.kill();
      } catch {
        /* already dead */
      }
      this.proc = null;
    }
    this.buffer = Buffer.alloc(0);
    this.sps = null;
    this.pps = null;
    this.pendingNonVcl = [];
  }

  private spawnSegment(
    adbPath: string,
    serial: string,
    streamId: number
  ): void {
    if (this.target?.serial !== serial || this.streamId !== streamId) return;
    this.buffer = Buffer.alloc(0);
    this.pendingNonVcl = [];
    const proc = spawn(
      adbPath,
      [
        "-s",
        serial,
        "exec-out",
        "screenrecord",
        "--output-format=h264",
        "--bit-rate",
        "6M",
        "--time-limit",
        "180",
        "-",
      ],
      { stdio: ["ignore", "pipe", "pipe"] }
    );
    this.proc = proc;
    proc.stdout.on("data", (chunk: Buffer) => {
      if (this.streamId !== streamId) return;
      this.buffer =
        this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
      this.drainNals(streamId);
    });
    // Without a reader the stderr buffer fills and screenrecord blocks.
    proc.stderr?.on("data", () => {});
    proc.on("exit", () => {
      if (this.streamId !== streamId || this.target == null) return;
      const now = Date.now();
      this.restartTimes = this.restartTimes.filter(
        (at) => now - at < RESTART_WINDOW_MS
      );
      if (this.restartTimes.length >= MAX_SCREENRECORD_RESTARTS) {
        this.stop();
        return;
      }
      this.restartTimes.push(now);
      this.restartTimer = setTimeout(() => {
        this.restartTimer = null;
        this.spawnSegment(adbPath, serial, streamId);
      }, RESTART_DELAY_MS);
    });
    proc.on("error", () => {
      if (this.streamId === streamId) this.stop();
    });
  }

  /** Extracts complete NAL units and emits access units. */
  private drainNals(streamId: number): void {
    for (;;) {
      const start = this.findStartCode(this.buffer, 0);
      if (start == null) break;
      const next = this.findStartCode(this.buffer, start.end);
      if (next == null) {
        // Incomplete trailing NAL; keep from this start code onward.
        if (start.begin > 0) this.buffer = this.buffer.subarray(start.begin);
        return;
      }
      const nal = this.buffer.subarray(start.begin, next.begin);
      this.handleNal(nal, start.end - start.begin, streamId);
      this.buffer = this.buffer.subarray(next.begin);
    }
    // No start code at all; cap growth.
    if (this.buffer.length > 4 * 1024 * 1024) this.buffer = Buffer.alloc(0);
  }

  private findStartCode(
    buf: Buffer,
    from: number
  ): { begin: number; end: number } | null {
    for (let i = from; i + 3 < buf.length; i++) {
      if (buf[i] === 0 && buf[i + 1] === 0) {
        if (buf[i + 2] === 1) return { begin: i, end: i + 3 };
        if (buf[i + 2] === 0 && buf[i + 3] === 1)
          return { begin: i, end: i + 4 };
      }
    }
    return null;
  }

  /** nal includes its start code; headerLen is the start-code length. */
  private handleNal(nal: Buffer, headerLen: number, streamId: number): void {
    const type = nal[headerLen] & 0x1f;
    if (type === 7) {
      this.sps = Buffer.from(nal);
      return;
    }
    if (type === 8) {
      this.pps = Buffer.from(nal);
      return;
    }
    if (type === 5 || type === 1) {
      const parts: Buffer[] = [];
      if (type === 5) {
        if (this.sps != null) parts.push(this.sps);
        if (this.pps != null) parts.push(this.pps);
      }
      parts.push(...this.pendingNonVcl, nal);
      this.pendingNonVcl = [];
      this.emitChunk({
        streamId,
        data: Buffer.concat(parts),
        isKey: type === 5,
      });
      return;
    }
    // SEI / AUD / other non-VCL ride along with the next frame.
    this.pendingNonVcl.push(Buffer.from(nal));
    if (this.pendingNonVcl.length > 32) this.pendingNonVcl = [];
  }

  private emitChunk(payload: {
    streamId: number;
    data: Buffer;
    isKey: boolean;
  }): void {
    const wc = this.wc;
    if (wc == null || wc.isDestroyed()) return;
    this.emitted += 1;
    try {
      wc.send(DEVICE_STREAM_CHUNK_CHANNEL, {
        streamId: payload.streamId,
        data: payload.data,
        isKey: payload.isKey,
        format: "h264",
      });
    } catch {
      /* renderer teardown race */
    }
  }
}
