/**
 * Microphone capture for dictation: MediaRecorder for the bytes, an analyser
 * for a level the button can pulse with, and a decode to the 16 kHz mono
 * float samples Whisper takes.
 */
import { WHISPER_SAMPLE_RATE } from "#shared/voice";

export type MicError =
  | "permission-denied"
  | "no-microphone"
  | "microphone-in-use"
  | "unsupported";

export class MicrophoneError extends Error {
  constructor(readonly reason: MicError) {
    super(reason);
  }
}

const toMicError = (error: unknown): MicrophoneError => {
  const name = error instanceof DOMException ? error.name : "";
  if (name === "NotAllowedError" || name === "SecurityError") {
    return new MicrophoneError("permission-denied");
  }
  if (name === "NotFoundError" || name === "DevicesNotFoundError") {
    return new MicrophoneError("no-microphone");
  }
  if (name === "NotReadableError" || name === "TrackStartError") {
    return new MicrophoneError("microphone-in-use");
  }
  return new MicrophoneError("unsupported");
};

const MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/mp4",
  "audio/ogg;codecs=opus",
];

export interface Recording {
  audio: Blob;
  durationMs: number;
}

export interface RecorderHandle {
  /** Resolves with the clip, or null when nothing was captured. */
  stop: () => Promise<Recording | null>;
  cancel: () => void;
}

export const startRecording = async (
  onLevel?: (level: number) => void
): Promise<RecorderHandle> => {
  if (
    navigator.mediaDevices?.getUserMedia == null ||
    typeof MediaRecorder === "undefined"
  ) {
    throw new MicrophoneError("unsupported");
  }
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
  } catch (error) {
    throw toMicError(error);
  }
  const mimeType = MIME_TYPES.find((type) =>
    MediaRecorder.isTypeSupported(type)
  );
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw toMicError(error);
  }

  const chunks: Blob[] = [];
  const startedAt = Date.now();
  let frame: number | null = null;
  let context: AudioContext | null = null;

  if (onLevel != null && typeof AudioContext !== "undefined") {
    try {
      context = new AudioContext();
      const analyser = context.createAnalyser();
      analyser.fftSize = 256;
      context.createMediaStreamSource(stream).connect(analyser);
      const data = new Uint8Array(analyser.fftSize);
      const tick = (): void => {
        analyser.getByteTimeDomainData(data);
        let sum = 0;
        for (const value of data) sum += (value - 128) ** 2;
        onLevel(Math.min(1, Math.sqrt(sum / data.length) / 42));
        frame = requestAnimationFrame(tick);
      };
      tick();
    } catch {
      context = null;
    }
  }

  const cleanup = (): void => {
    if (frame != null) cancelAnimationFrame(frame);
    void context?.close();
    stream.getTracks().forEach((track) => track.stop());
  };

  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };
  recorder.start();

  return {
    stop: () =>
      new Promise<Recording | null>((resolve) => {
        if (recorder.state === "inactive") {
          cleanup();
          resolve(null);
          return;
        }
        recorder.onstop = () => {
          cleanup();
          resolve(
            chunks.length === 0
              ? null
              : {
                  audio: new Blob(chunks, {
                    type: recorder.mimeType || mimeType || "audio/webm",
                  }),
                  durationMs: Date.now() - startedAt,
                }
          );
        };
        recorder.stop();
      }),
    cancel: () => {
      recorder.ondataavailable = null;
      recorder.onstop = null;
      if (recorder.state !== "inactive") recorder.stop();
      cleanup();
    },
  };
};

/** Decode a clip to mono samples at Whisper's rate. */
export const decodeForWhisper = async (audio: Blob): Promise<Float32Array> => {
  const bytes = await audio.arrayBuffer();
  const probe = new AudioContext();
  let decoded: AudioBuffer;
  try {
    decoded = await probe.decodeAudioData(bytes);
  } finally {
    void probe.close();
  }
  const length = Math.ceil(decoded.duration * WHISPER_SAMPLE_RATE);
  const offline = new OfflineAudioContext(1, length, WHISPER_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  const rendered = await offline.startRendering();
  return rendered.getChannelData(0);
};
