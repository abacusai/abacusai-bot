/**
 * Whisper in the renderer. The library and its model load on first use only:
 * the model files arrive through main (the renderer's CSP allows no other
 * host), the WebAssembly runtime is bundled beside the app, and inference
 * runs on WebGPU when the machine has it, WebAssembly otherwise.
 */
import ortWasmUrl from "ort-dist/ort-wasm-simd-threaded.asyncify.wasm?url";

import { WHISPER_MODEL_ID } from "#shared/voice";

type Transformers = typeof import("@huggingface/transformers");
type Transcriber =
  import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline;

export type WhisperDevice = "webgpu" | "wasm";

let loading: Promise<{
  transcriber: Transcriber;
  device: WhisperDevice;
}> | null = null;

/** The model files, routed through main; anything else is refused. */
const fetchThroughMain = async (
  input: string | URL,
  _init?: unknown
): Promise<Response> => {
  const result = await window.api.agent.fetchWhisperFile(String(input));
  if (result.status !== 200 || result.data == null) {
    return new Response(null, {
      status: result.status,
      statusText: result.error ?? "",
    });
  }
  return new Response(result.data, {
    status: 200,
    headers: { "content-length": String(result.data.byteLength) },
  });
};

const configure = (transformers: Transformers, device: WhisperDevice): void => {
  const { env } = transformers;
  env.allowLocalModels = false;
  env.allowRemoteModels = true;
  env.useBrowserCache = false;
  env.useCustomCache = false;
  // Main keeps the files on disk; a second cache here would double them.
  env.useWasmCache = false;
  env.fetch = fetchThroughMain as typeof env.fetch;
  const wasm = env.backends.onnx.wasm;
  if (wasm != null) {
    // The runtime's default build carries its own loader; only the binary
    // needs a path, and it must be ours rather than the library's CDN.
    wasm.wasmPaths = { wasm: ortWasmUrl };
    // Worker threads need a cross-origin-isolated page; one thread is what
    // this renderer can offer, and WebGPU carries the heavy part anyway.
    wasm.numThreads = 1;
    wasm.proxy = false;
  }
  if (device === "webgpu" && env.backends.onnx.webgpu != null) {
    env.backends.onnx.webgpu.powerPreference = "high-performance";
  }
};

const load = async (): Promise<{
  transcriber: Transcriber;
  device: WhisperDevice;
}> => {
  const transformers = await import("@huggingface/transformers");
  const devices: WhisperDevice[] =
    "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
  let lastError: unknown;
  for (const device of devices) {
    configure(transformers, device);
    try {
      const transcriber = (await transformers.pipeline(
        "automatic-speech-recognition",
        WHISPER_MODEL_ID,
        { device, dtype: "q8" }
      )) as Transcriber;
      console.info(`[dictation] whisper ready on ${device}`);
      return { transcriber, device };
    } catch (error) {
      // A WebGPU adapter the browser advertises but cannot create falls back
      // to WebAssembly rather than failing the button.
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/** The transcriber, loaded once per renderer; a failed load can be retried. */
export const whisper = (): Promise<{
  transcriber: Transcriber;
  device: WhisperDevice;
}> => {
  loading ??= load().catch((error: unknown) => {
    loading = null;
    throw error;
  });
  return loading;
};

/** 16 kHz mono samples in, text out. Long clips are windowed by the model. */
export const transcribe = async (samples: Float32Array): Promise<string> => {
  const { transcriber } = await whisper();
  const output = (await transcriber(samples, {
    chunk_length_s: 30,
    stride_length_s: 5,
    task: "transcribe",
    return_timestamps: false,
  })) as { text?: string } | { text?: string }[];
  const text = Array.isArray(output)
    ? output.map((entry) => entry.text ?? "").join(" ")
    : (output.text ?? "");
  return cleanTranscript(text);
};

/** Whisper's known outputs on silence, which are noise rather than speech. */
const HALLUCINATIONS = new Set([
  "you",
  "thank you",
  "thanks for watching",
  "thank you for watching",
  "subtitles by the amara.org community",
  "[blank_audio]",
  "[silence]",
  "[music]",
]);

export const cleanTranscript = (text: string): string => {
  const cleaned = text.replace(/\s+/g, " ").trim();
  const key = cleaned.toLowerCase().replace(/[.!?,]+$/, "");
  return HALLUCINATIONS.has(key) ? "" : cleaned;
};
