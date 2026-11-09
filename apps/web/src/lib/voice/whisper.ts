/**
 * Whisper in the renderer. The library and its models load on first use only:
 * the model files arrive through the host, the WebAssembly runtime is bundled
 * beside the app. Inference runs on WebGPU when available, WebAssembly otherwise.
 */
import {
  type DictationLanguage,
  WHISPER_BASE_MODEL_ID,
  WHISPER_SAMPLE_RATE,
  WHISPER_SMALL_MODEL_ID,
  type WhisperModelId,
} from "@abacus-ai/contract/voice";
import ortWasmUrl from "ort-dist/ort-wasm-simd-threaded.asyncify.wasm?url";

import { fetchHostModel } from "#platform/host-files";
import type { Transport } from "#renderer/data/transport";
import { IS_BROWSER } from "#renderer/lib/platform";

import {
  chooseDictationLanguage,
  dictationLanguageCode,
  dictationModel,
  type LanguageScore,
} from "./dictation-language";
import { setDictationNote } from "./download-status";

type Transformers = typeof import("@huggingface/transformers");
type Transcriber =
  import("@huggingface/transformers").AutomaticSpeechRecognitionPipeline;

export type WhisperDevice = "webgpu" | "wasm";
interface Loaded {
  transcriber: Transcriber;
  device: WhisperDevice;
}

let transport: Transport;
let inFlight = 0;
const idleWaiters = new Set<() => void>();
let disposal: ReturnType<typeof setTimeout> | undefined;
export const configureVoice = (value: Transport): void => {
  transport = value;
};
const loading = new Map<WhisperModelId, Promise<Loaded>>();
/** Small failed to load in this renderer: base serves until `disposeWhisper` or a reload. */
let smallFailed = false;
/** Below this RMS a clip is silence or room noise: nothing to transcribe, nothing to download. */
const SILENCE_RMS = 0.003;
/** Clips shorter than this are too short to trust a non-confident language pick. */
const MIN_DOWNLOAD_CLIP_S = 2;

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

const load = async (model: WhisperModelId): Promise<Loaded> => {
  const transformers = await import("@huggingface/transformers");
  const devices: WhisperDevice[] =
    "gpu" in navigator ? ["webgpu", "wasm"] : ["wasm"];
  let lastError: unknown;
  for (const device of devices) {
    configure(transformers, device);
    try {
      const transcriber = (await transformers.pipeline(
        "automatic-speech-recognition",
        model,
        { device, dtype: "q8" }
      )) as Transcriber;
      console.info(`[dictation] ${model} ready on ${device}`);
      return { transcriber, device };
    } catch (error) {
      // A WebGPU adapter the browser advertises but cannot create falls back
      // to WebAssembly rather than failing the button.
      lastError = error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
};

/** A model's transcriber, loaded once per renderer; a failed load can be retried. */
export const whisper = (
  model: WhisperModelId = WHISPER_BASE_MODEL_ID
): Promise<Loaded> => {
  let pending = loading.get(model);
  if (pending == null) {
    pending = load(model).catch((error: unknown) => {
      loading.delete(model);
      throw error;
    });
    loading.set(model, pending);
  }
  return pending;
};

/** The user's language from the host's resolver; null when the host cannot say. */
const userLanguage = (): Promise<DictationLanguage | null> =>
  transport.client.voice.language({}).catch(() => null);

/** Whether small is on disk; asking starts its download when it is not. */
const prepareSmall = (): Promise<boolean> =>
  transport.client.voice.whisper
    .prepare({ model: WHISPER_SMALL_MODEL_ID })
    .catch(() => false);

/** Fetches small ahead of the first clip when the user's language is not English. */
export const prepareDictation = async (): Promise<void> => {
  const user = await userLanguage();
  if (user != null && user.name !== "English") await prepareSmall();
};

/** Whisper's start token and `<|fr|>` language tokens, from the model's generation config. */
interface Disposable {
  dispose(): void;
}

const whisperTokens = ({ transcriber }: Loaded) =>
  transcriber.model.generation_config as unknown as {
    decoder_start_token_id: number;
    lang_to_id: Record<string, number>;
  };

/** Whisper's language step: one decoder step from start-of-transcript over the first 30 s. */
const detectLanguage = async (
  loaded: Loaded,
  samples: Float32Array
): Promise<LanguageScore[]> => {
  const { Tensor } = await import("@huggingface/transformers");
  const { model, processor } = loaded.transcriber;
  const config = whisperTokens(loaded);
  const { input_features } = (await processor(
    samples.subarray(0, 30 * WHISPER_SAMPLE_RATE)
  )) as { input_features: Disposable };
  const start = new Tensor(
    "int64",
    BigInt64Array.from([BigInt(config.decoder_start_token_id)]),
    [1, 1]
  );
  let output: Record<string, Disposable & { data?: unknown }> = {};
  let logits: Float32Array;
  try {
    output = (await model({
      input_features,
      decoder_input_ids: start,
    })) as typeof output;
    logits = Float32Array.from(output.logits!.data as Float32Array);
  } finally {
    // The decoder's present.* key/values live on the GPU under WebGPU; only the logits are kept.
    for (const tensor of [input_features, start, ...Object.values(output)])
      tensor.dispose();
  }
  const tokens = Object.entries(config.lang_to_id);
  const max = Math.max(...tokens.map(([, id]) => logits[id] ?? -Infinity));
  const weights = tokens.map(([token, id]) => ({
    code: token.slice(2, -2),
    p: Math.exp((logits[id] ?? -Infinity) - max),
  }));
  const sum = weights.reduce((total, { p }) => total + p, 0);
  return weights
    .map(({ code, p }) => ({ code, p: p / sum }))
    .sort((a, b) => b.p - a.p);
};

/** The codes a model can transcribe in, from its own language tokens. */
const supportedLanguages = (loaded: Loaded): string[] =>
  Object.keys(whisperTokens(loaded).lang_to_id).map((token) =>
    token.slice(2, -2)
  );

/**
 * 16 kHz mono samples in, text out, in the language spoken: the audio picks
 * it, the user's language breaks a tie, and it is always passed explicitly,
 * since the library would otherwise force English and translate.
 */
export const transcribe = async (samples: Float32Array): Promise<string> => {
  clearTimeout(disposal);
  ++inFlight;
  try {
    if (rms(samples) < SILENCE_RMS) return "";
    const base = await whisper(WHISPER_BASE_MODEL_ID);
    const [user, scores] = await Promise.all([
      userLanguage(),
      detectLanguage(base, samples).catch((error: unknown) => {
        console.warn("[dictation] language step failed", error);
        return [] as LanguageScore[];
      }),
    ]);
    const supported = supportedLanguages(base);
    const userCode =
      user == null ? null : dictationLanguageCode(user.name, supported);
    const { language, confident } = chooseDictationLanguage(scores, {
      code: userCode,
      localeTags: [
        ...(user == null ? [] : [user.locale]),
        ...navigator.languages,
      ],
    });
    // A short, unsure clip may be misheard: it never starts the 238 MB download.
    const trusted =
      confident || samples.length >= MIN_DOWNLOAD_CLIP_S * WHISPER_SAMPLE_RATE;
    const model = dictationModel(
      language,
      language !== "en" && !smallFailed && trusted && (await prepareSmall())
    );
    setDictationNote({
      language: language === "en" ? null : language,
      quick: language !== "en" && model === WHISPER_BASE_MODEL_ID,
    });
    const top = scores[0];
    console.info(
      `[dictation] heard ${top?.code ?? "?"} ${top?.p.toFixed(2) ?? "-"}, ` +
        `user ${user?.name ?? "?"}, language ${language}, ` +
        `model ${model === WHISPER_SMALL_MODEL_ID ? "small" : "base"}`
    );
    // A small model that cannot load (memory, a broken file) leaves base, with the language set.
    const { transcriber } =
      model === WHISPER_BASE_MODEL_ID
        ? base
        : await whisper(model).catch((error: unknown) => {
            console.warn(`[dictation] ${model} failed to load`, error);
            smallFailed = true;
            return base;
          });
    const output = (await transcriber(samples, {
      chunk_length_s: 30,
      stride_length_s: 5,
      task: "transcribe",
      language,
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
  smallFailed = false;
  const pending = [...loading.values()];
  loading.clear();
  await Promise.all(
    pending.map(async (load) => {
      try {
        const { transcriber } = await load;
        await transcriber.dispose();
      } catch {
        /* failed loads own no pipeline */
      }
    })
  );
};

const rms = (samples: Float32Array): number => {
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return samples.length === 0 ? 0 : Math.sqrt(sum / samples.length);
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
