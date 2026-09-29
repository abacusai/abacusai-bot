import type { DeviceStreamChunk } from "#shared/contracts";

/**
 * WebCodecs H.264 decode pipeline for the Android device stream.
 * Consumes Annex-B access units from the main-process DeviceStreamService
 * and paints decoded frames onto a canvas. Self-contained so device-panel
 * stays declarative; call dispose() on unmount.
 */
export class AndroidStreamPlayer {
  private decoder: VideoDecoder | null = null;
  private configured = false;
  private streamId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private timestamp = 0;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** screenrecord needs a moment to start; no decoded frame by then → poll. */
  private static readonly FIRST_FRAME_TIMEOUT_MS = 5000;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFatal: (reason: string) => void
  ) {}

  static isSupported(): boolean {
    return (
      typeof VideoDecoder !== "undefined" &&
      typeof EncodedVideoChunk !== "undefined"
    );
  }

  async start(deviceId: string): Promise<void> {
    if (!AndroidStreamPlayer.isSupported()) {
      console.warn(
        "[device-stream] WebCodecs VideoDecoder unavailable in this renderer; staying on screenshot polling."
      );
      this.onFatal("WebCodecs unavailable");
      return;
    }
    const result = await window.api?.agent?.startDeviceStream?.({
      deviceId,
    });
    if (this.disposed) {
      void window.api?.agent
        ?.stopDeviceStream?.(result?.streamId ?? undefined)
        ?.catch(() => {});
      return;
    }
    if (result?.success !== true || result.streamId == null) {
      console.warn(
        "[device-stream] startDeviceStream failed:",
        result?.error ?? "(no reason)"
      );
      this.onFatal(result?.error ?? "stream failed to start");
      return;
    }
    this.streamId = result.streamId;
    this.unsubscribe =
      window.api?.agent?.onDeviceStreamChunk?.((chunk) =>
        this.onChunk(chunk)
      ) ?? null;
    this.watchdog = setTimeout(() => {
      if (!this.painted && !this.disposed) {
        console.warn(
          `[device-stream] Android stream produced no decoded frame in ${AndroidStreamPlayer.FIRST_FRAME_TIMEOUT_MS}ms (chunks received: ${this.received}); falling back to polling`
        );
        this.onFatal("no frames decoded");
      }
    }, AndroidStreamPlayer.FIRST_FRAME_TIMEOUT_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog != null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    if (this.rafId !== 0) {
      cancelAnimationFrame(this.rafId);
      this.rafId = 0;
    }
    this.pendingFrame?.close();
    this.pendingFrame = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    if (this.decoder != null && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        /* already closed */
      }
    }
    this.decoder = null;
    // Scoped to our own stream: a late teardown must not kill a newer one.
    void window.api?.agent
      ?.stopDeviceStream?.(this.streamId ?? undefined)
      ?.catch(() => {});
  }

  private received = 0;
  private onChunk(chunk: DeviceStreamChunk): void {
    if (this.disposed || chunk.streamId !== this.streamId) return;
    if (chunk.format === "mjpeg") return; // not ours; that's the iOS framebuffer path
    try {
      const data =
        chunk.data instanceof Uint8Array
          ? chunk.data
          : new Uint8Array(chunk.data);
      this.received += 1;
      if (chunk.isKey) {
        // Every keyframe carries SPS/PPS, so (re)configure lazily so segment
        // restarts (screenrecord's 3-minute limit) recover transparently.
        const codec = this.codecFromSps(data);
        if (this.decoder == null || !this.configured) {
          if (codec != null) {
            this.ensureDecoder(codec);
          } else {
            console.warn(
              "[device-stream] keyframe without parseable SPS; cannot configure decoder"
            );
          }
        }
      }
      if (this.decoder == null || !this.configured) return;
      if (this.decoder.decodeQueueSize > 8 && !chunk.isKey) return; // drop under backpressure
      this.timestamp += 33_000;
      this.decoder.decode(
        new EncodedVideoChunk({
          type: chunk.isKey ? "key" : "delta",
          timestamp: this.timestamp,
          data,
        })
      );
    } catch (err) {
      console.warn(
        "[device-stream] decode threw:",
        err instanceof Error ? err.message : err
      );
      this.onFatal(err instanceof Error ? err.message : String(err));
    }
  }

  private ensureDecoder(codec: string): void {
    if (this.decoder != null && this.decoder.state !== "closed") {
      try {
        this.decoder.close();
      } catch {
        /* ignore */
      }
    }
    this.decoder = new VideoDecoder({
      // paint() takes ownership of the frame and closes it. Decode can burst
      // several frames between two display refreshes and only the newest is
      // worth uploading.
      output: (frame) => this.paint(frame),
      error: (err) => {
        if (!this.disposed) {
          console.warn(
            "[device-stream] decoder error, falling back to polling:",
            err.message
          );
          this.onFatal(err.message);
        }
      },
    });
    // No `description` → the decoder expects Annex-B input, which is exactly
    // what screenrecord produces.
    this.decoder.configure({ codec, optimizeForLatency: true });
    this.configured = true;
  }

  private painted = false;
  private pendingFrame: VideoFrame | null = null;
  private rafId = 0;
  private ctx: CanvasRenderingContext2D | null = null;

  /**
   * Queue a decoded frame for the next display refresh. Decode arrives in
   * bursts, so only the newest frame per rAF is uploaded; nothing visible is
   * dropped. Takes ownership: every frame is closed exactly once.
   */
  private paint(frame: VideoFrame): void {
    if (this.disposed) {
      frame.close();
      return;
    }
    if (!this.painted) {
      this.painted = true;
      if (this.watchdog != null) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
    }
    this.pendingFrame?.close(); // superseded before it was ever shown
    this.pendingFrame = frame;
    if (this.rafId !== 0) return;
    this.rafId = requestAnimationFrame(() => {
      this.rafId = 0;
      const next = this.pendingFrame;
      this.pendingFrame = null;
      if (next == null) return;
      if (!this.disposed) this.draw(next);
      next.close();
    });
  }

  private draw(frame: VideoFrame): void {
    const canvas = this.canvas;
    const width = frame.displayWidth;
    const height = frame.displayHeight;
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
      this.ctx = null; // resizing a canvas invalidates its drawing state
    }
    // `alpha: false` skips compositing an opaque frame; `desynchronized` lets
    // the compositor present without waiting on the page. Cached: getContext()
    // per frame is not free.
    this.ctx ??= canvas.getContext("2d", {
      alpha: false,
      desynchronized: true,
    });
    this.ctx?.drawImage(frame, 0, 0);
  }

  /** Builds the avc1.PPCCLL codec string from the SPS inside a keyframe AU. */
  private codecFromSps(data: Uint8Array): string | null {
    for (let i = 0; i + 4 < data.length; i++) {
      if (data[i] !== 0 || data[i + 1] !== 0) continue;
      let headerEnd: number | null = null;
      if (data[i + 2] === 1) headerEnd = i + 3;
      else if (data[i + 2] === 0 && data[i + 3] === 1) headerEnd = i + 4;
      if (headerEnd == null) continue;
      if ((data[headerEnd] & 0x1f) === 7 && headerEnd + 3 < data.length) {
        const hex = (b: number): string =>
          b.toString(16).padStart(2, "0").toUpperCase();
        return `avc1.${hex(data[headerEnd + 1])}${hex(data[headerEnd + 2])}${hex(data[headerEnd + 3])}`;
      }
    }
    return null;
  }
}

/**
 * MJPEG decode pipeline for the iOS Simulator framebuffer stream: paints the
 * helper's length-prefixed JPEG frames at exact device pixels so taps map 1:1.
 * Decodes are dropped, not queued, while one is in flight.
 */
export class MjpegStreamPlayer {
  private streamId: number | null = null;
  private unsubscribe: (() => void) | null = null;
  private disposed = false;
  private decoding = false;
  private painted = false;
  private watchdog: ReturnType<typeof setTimeout> | null = null;
  /** start() resolves once capture is running; give SCK a beat to deliver. */

  private static readonly FIRST_FRAME_TIMEOUT_MS = 4000;

  constructor(
    private readonly canvas: HTMLCanvasElement,
    private readonly onFatal: (reason: string) => void,
    private readonly onFirstFrame?: () => void
  ) {}

  static isSupported(): boolean {
    return typeof createImageBitmap !== "undefined";
  }

  async start(deviceId: string): Promise<void> {
    if (!MjpegStreamPlayer.isSupported()) {
      this.onFatal("createImageBitmap unavailable");
      return;
    }
    const result = await window.api?.agent?.startDeviceStream?.({
      deviceId,
      platform: "ios",
    });
    if (this.disposed) {
      void window.api?.agent
        ?.stopDeviceStream?.(result?.streamId ?? undefined)
        ?.catch(() => {});
      return;
    }
    if (result?.success !== true || result.streamId == null) {
      console.warn(
        "[device-stream] iOS native mirror failed to start:",
        result?.error ?? "(no reason)"
      );
      this.onFatal(result?.error ?? "stream failed to start");
      return;
    }
    this.streamId = result.streamId;
    this.unsubscribe =
      window.api?.agent?.onDeviceStreamChunk?.(
        (chunk) => void this.onChunk(chunk)
      ) ?? null;
    this.watchdog = setTimeout(() => {
      if (!this.painted && !this.disposed) {
        console.warn(
          "[device-stream] iOS native mirror produced no frames; falling back to window capture"
        );
        this.onFatal("no frames from framebuffer");
      }
    }, MjpegStreamPlayer.FIRST_FRAME_TIMEOUT_MS);
  }

  dispose(): void {
    this.disposed = true;
    if (this.watchdog != null) {
      clearTimeout(this.watchdog);
      this.watchdog = null;
    }
    this.unsubscribe?.();
    this.unsubscribe = null;
    // Scoped to our own stream: a late teardown must not kill a newer one.
    void window.api?.agent
      ?.stopDeviceStream?.(this.streamId ?? undefined)
      ?.catch(() => {});
  }

  private async onChunk(chunk: DeviceStreamChunk): Promise<void> {
    if (
      this.disposed ||
      chunk.streamId !== this.streamId ||
      chunk.format !== "mjpeg"
    )
      return;
    if (this.decoding) return; // drop under backpressure; never queue
    this.decoding = true;
    try {
      const data =
        chunk.data instanceof Uint8Array
          ? chunk.data
          : new Uint8Array(chunk.data);
      const bitmap = await createImageBitmap(
        new Blob([data as BlobPart], { type: "image/jpeg" })
      );
      if (this.disposed) {
        bitmap.close();
        return;
      }
      this.paint(bitmap);
      bitmap.close();
    } catch {
      /* skip a corrupt frame; the next one recovers */
    } finally {
      this.decoding = false;
    }
  }

  private paint(bitmap: ImageBitmap): void {
    if (!this.painted) {
      this.painted = true;
      if (this.watchdog != null) {
        clearTimeout(this.watchdog);
        this.watchdog = null;
      }
      this.onFirstFrame?.();
    }
    const canvas = this.canvas;
    if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
    }
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0);
  }
}

export class ScreenPermissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScreenPermissionError";
  }
}

/** Starts a desktopCapturer getUserMedia stream of the iOS Simulator window. */
export const captureSimulatorWindow = async (
  deviceName: string
): Promise<MediaStream> => {
  const source = await window.api?.agent?.getSimulatorWindowSource?.({
    deviceName,
  });
  if (source?.sourceId == null) {
    if (
      source?.screenPermission != null &&
      source.screenPermission !== "granted"
    ) {
      throw new ScreenPermissionError(
        source.error ?? "Screen Recording permission required"
      );
    }
    throw new Error(source?.error ?? "Simulator window not found");
  }
  const constraints = {
    audio: false,
    video: {
      mandatory: {
        chromeMediaSource: "desktop",
        chromeMediaSourceId: source.sourceId,
        maxFrameRate: 60,
      },
    },
  } as unknown as MediaStreamConstraints;
  return navigator.mediaDevices.getUserMedia(constraints);
};
