import { WHISPER_MODEL_ID } from "@abacus-ai/contract/voice";
/**
 * Whisper in the renderer. The library and its model load on first use only:
 * the model files arrive through the host, the WebAssembly runtime is bundled
 * beside the app. Inference runs on WebGPU when available, WebAssembly otherwise.
 */
import ortWasmUrl from "ort-dist/ort-wasm-simd-threaded.asyncify.wasm?url";

import { fetchHostModel } from "#platform/host-files";
import type { Transport } from "#renderer/data/transport";
import { IS_BROWSER } from "#renderer/lib/platform";

type Transformers = typeof import("@huggingface/transformers");
type Transcriber =
  import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline;

export type WhisperDevice = "webgpu" | "wasm";

let transport: Transport;
let inFlight = 0;
const idleWaiters = new Set<() => void>();
let disposal: ReturnType<typeof setTimeout> | undefined;
export const configureVoice = (value: Transport): void => {
  transport = value;
};
let loading: Promise<{
  transcriber: Transcriber;
  device: WhisperDevice;
}> | null = null;

/** Model downloads use authenticated HTTP in the browser and RPC on Electron. */
export const fetchWhisperModel = async (
  input: string | URL,
  _init?: unknown
): Promise<Response> => {
  if (IS_BROWSER) {
    return fetchHostModel(String(input));
  }
  const result = await transport.client.voice.whisper.fetch({
    url: String(input),
  });
  if (result.status !== 200 || result.data == null) {
    return new Response(null, {
      status: result.status,
      statusText: result.error ?? "",
    });
  }
  return new Response(new Uint8Array(result.data).buffer, {
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
  env.fetch = fetchWhisperModel as typeof env.fetch;
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
  clearTimeout(disposal);
  ++inFlight;
  try {
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
  } finally {
    --inFlight;
    if (!inFlight) {
      for (const resolve of idleWaiters) resolve();
      idleWaiters.clear();
    }
    if (!inFlight)
      disposal = setTimeout(() => {
        void disposeWhisper();
      }, 120_000);
  }
};

export const disposeWhisper = async (): Promise<void> => {
  if (inFlight) await new Promise<void>((resolve) => idleWaiters.add(resolve));
  clearTimeout(disposal);
  if (!loading) return;
  const pending = loading;
  loading = null;
  try {
    const { transcriber } = await pending;
    await transcriber.dispose();
  } catch {
    /* failed loads own no pipeline */
  }
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
