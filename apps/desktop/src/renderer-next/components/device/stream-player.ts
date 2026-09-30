import type { DeviceStreamChunk } from "#shared/contracts";
export const codecFromSps = (data: Uint8Array): string | null => {
  for (let i = 0; i + 4 < data.length; i++) {
    if (data[i] !== 0 || data[i + 1] !== 0) continue;
    const offset =
      data[i + 2] === 1
        ? i + 3
        : data[i + 2] === 0 && data[i + 3] === 1
          ? i + 4
          : 0;
    if (offset && (data[offset]! & 31) === 7 && offset + 3 < data.length)
      return `avc1.${[data[offset + 1], data[offset + 2], data[offset + 3]].map((b) => b!.toString(16).padStart(2, "0")).join("")}`;
  }
  return null;
};
/** Owns frames and the decoder; it accepts only a key frame after start or overflow. */
export class DeviceStreamPlayer {
  private decoder: VideoDecoder | null = null;
  private disposed = false;
  private barrier = true;
  private timestamp = 0;
  private decoding = false;
  private codec: string | null = null;
  constructor(
    private canvas: HTMLCanvasElement,
    private fatal: (error: unknown) => void
  ) {}
  resetBarrier() {
    this.barrier = true;
  }
  private paint(frame: VideoFrame | ImageBitmap) {
    try {
      if (this.disposed) return;
      const width =
        frame instanceof ImageBitmap ? frame.width : frame.displayWidth;
      const height =
        frame instanceof ImageBitmap ? frame.height : frame.displayHeight;
      this.canvas.width = width;
      this.canvas.height = height;
      this.canvas
        .getContext("2d", { alpha: false, desynchronized: true })
        ?.drawImage(frame, 0, 0);
    } finally {
      frame.close();
    }
  }
  async push(chunk: DeviceStreamChunk) {
    if (this.disposed) return;
    if (this.barrier && !chunk.isKey) return;
    if (chunk.format === "mjpeg") {
      if (this.decoding) return;
      this.decoding = true;
      try {
        const bytes = new Uint8Array(chunk.data);
        const frame = await createImageBitmap(
          new Blob([bytes], { type: "image/jpeg" })
        );
        this.paint(frame);
        this.barrier = false;
      } catch (error) {
        this.fatal(error);
      } finally {
        this.decoding = false;
      }
      return;
    }
    try {
      if (chunk.isKey) {
        const codec = codecFromSps(chunk.data);
        if (
          codec &&
          (this.codec !== codec || this.decoder?.state !== "configured")
        ) {
          this.decoder?.close();
          this.decoder = new VideoDecoder({
            output: (frame) => this.paint(frame),
            error: (error) => {
              this.barrier = true;
              this.fatal(error);
            },
          });
          this.decoder.configure({ codec, optimizeForLatency: true });
          this.codec = codec;
        }
      }
      if (!this.decoder || this.decoder.state !== "configured") return;
      if (this.decoder.decodeQueueSize > 8 && !chunk.isKey) {
        this.barrier = true;
        return;
      }
      this.barrier = false;
      this.timestamp += 33000;
      this.decoder.decode(
        new EncodedVideoChunk({
          type: chunk.isKey ? "key" : "delta",
          timestamp: this.timestamp,
          data: chunk.data,
        })
      );
    } catch (error) {
      this.barrier = true;
      this.fatal(error);
    }
  }
  dispose() {
    this.disposed = true;
    if (this.decoder?.state !== "closed") this.decoder?.close();
    this.decoder = null;
  }
}
