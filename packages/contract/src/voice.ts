/**
 * Voice input: speech is transcribed on this machine by Whisper, running in
 * the renderer on WebGPU or WebAssembly. The model files come from Hugging
 * Face once, through the main process, and live under the app home after.
 */

/** English dictation: small and fast. */
export const WHISPER_BASE_MODEL_ID = "onnx-community/whisper-base";
/** Every other language: base breaks scripts such as Hindi and Portuguese. */
export const WHISPER_SMALL_MODEL_ID = "onnx-community/whisper-small";
export const WHISPER_MODEL_IDS = [
  WHISPER_BASE_MODEL_ID,
  WHISPER_SMALL_MODEL_ID,
] as const;
export type WhisperModelId = (typeof WHISPER_MODEL_IDS)[number];
export const WHISPER_REMOTE_HOST = "https://huggingface.co/";
/** The files the transcriber loads (q8); a model is ready when all are on disk. */
export const WHISPER_MODEL_FILES = [
  "config.json",
  "generation_config.json",
  "preprocessor_config.json",
  "tokenizer.json",
  "tokenizer_config.json",
  "onnx/encoder_model_quantized.onnx",
  "onnx/decoder_model_merged_quantized.onnx",
] as const;

/** The user's language as dictation reads it: the reply language and the app's locale tag. */
export interface DictationLanguage {
  /** English name, from the reply-language resolver: "French". */
  name: string;
  /** BCP 47 tag of the app's language, e.g. "fr-FR". */
  locale: string;
}

/** What the renderer gets back for one model file it asked for. */
export interface WhisperFileResult {
  /** 200 with bytes, 404 for a file the repo does not have, 502 otherwise. */
  status: number;
  data?: ArrayBuffer;
  error?: string;
}

export interface WhisperDownloadProgress {
  model: WhisperModelId;
  /** Path inside the model repo, e.g. `onnx/encoder_model_quantized.onnx`. */
  file: string;
  loadedBytes: number;
  totalBytes: number;
  done: boolean;
}

/** Sample rate Whisper's feature extractor expects. */
export const WHISPER_SAMPLE_RATE = 16_000;
