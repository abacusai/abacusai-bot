/**
 * The encoder half of a motion render (main: services/agent-tools/motion-agent.ts).
 *
 * Runs in the preload of the hidden window that shows the motion page. The
 * main process seeks the page, captures a frame and sends its pixels here;
 * this encodes them with WebCodecs (H.264, Chromium's own encoder: no ffmpeg
 * ships with the app) and muxes them into an MP4. One frame is in flight at a
 * time: each is acknowledged once the encoder has room, which keeps memory
 * flat however long the video.
 *
 * Nothing is exposed to the page: it is the model's content, filled into one
 * of our templates, and has no business with the encoder.
 */
import { ipcRenderer } from "electron";
import { ArrayBufferTarget, Muxer } from "mp4-muxer";

export type MotionEncoderStart = {
  width: number;
  height: number;
  fps: number;
  /** A second attempt after the default (often hardware) encoder failed. */
  software?: boolean;
};

/**
 * High profile first, then Main and Baseline: a machine whose encoder lacks
 * High still makes a video. Level 4.0 covers 1920×1080 and 1080×1920.
 */
const CODECS = ["avc1.640028", "avc1.4d0028", "avc1.420028"];

/** Enough bits for crisp type at 1080p without a 30 s clip passing ~20 MB. */
const bitrateFor = (width: number, height: number): number =>
  Math.round(width * height * 4);

export function installMotionEncoder(): void {
  let encoder: VideoEncoder | null = null;
  let muxer: Muxer<ArrayBufferTarget> | null = null;
  let config: MotionEncoderStart | null = null;
  let failure: string | null = null;

  const fail = (error: unknown): void => {
    failure ??= error instanceof Error ? error.message : String(error);
  };

  ipcRenderer.on(
    "motion:start",
    async (_event, start: MotionEncoderStart): Promise<void> => {
      try {
        config = start;
        const base = {
          width: start.width,
          height: start.height,
          bitrate: bitrateFor(start.width, start.height),
          framerate: start.fps,
          latencyMode: "quality" as const,
          ...(start.software === true
            ? { hardwareAcceleration: "prefer-software" as const }
            : {}),
        };
        let codec: string | null = null;
        for (const candidate of CODECS) {
          const support = await VideoEncoder.isConfigSupported({
            ...base,
            codec: candidate,
          });
          if (support.supported === true) {
            codec = candidate;
            break;
          }
        }
        if (codec == null)
          throw new Error("This machine has no H.264 video encoder.");

        muxer = new Muxer({
          target: new ArrayBufferTarget(),
          video: { codec: "avc", width: start.width, height: start.height },
          fastStart: "in-memory",
        });
        const sink = muxer;
        encoder = new VideoEncoder({
          output: (chunk, meta) => sink.addVideoChunk(chunk, meta),
          error: fail,
        });
        encoder.configure({ ...base, codec });
        ipcRenderer.send("motion:ready", { codec });
      } catch (error) {
        fail(error);
        ipcRenderer.send("motion:ready", { error: failure });
      }
    }
  );

  ipcRenderer.on(
    "motion:frame",
    async (
      _event,
      pixels: Uint8Array,
      width: number,
      height: number,
      index: number
    ): Promise<void> => {
      try {
        if (encoder == null || config == null)
          throw new Error("The encoder was not started.");
        if (failure == null) {
          const frame = new VideoFrame(pixels, {
            format: "BGRA",
            codedWidth: width,
            codedHeight: height,
            timestamp: Math.round((index * 1_000_000) / config.fps),
            duration: Math.round(1_000_000 / config.fps),
          });
          // A keyframe every two seconds: seeking in a player stays quick.
          encoder.encode(frame, { keyFrame: index % (config.fps * 2) === 0 });
          frame.close();
          while (encoder.encodeQueueSize > 2 && failure == null)
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
      } catch (error) {
        fail(error);
      }
      ipcRenderer.send("motion:ack", index, failure);
    }
  );

  ipcRenderer.on("motion:finish", async (): Promise<void> => {
    try {
      if (encoder == null || muxer == null)
        throw new Error("The encoder was not started.");
      await encoder.flush();
      encoder.close();
      muxer.finalize();
      if (failure != null) throw new Error(failure);
      ipcRenderer.send("motion:done", {
        bytes: new Uint8Array(muxer.target.buffer),
      });
    } catch (error) {
      fail(error);
      ipcRenderer.send("motion:done", { error: failure });
    }
  });
}
