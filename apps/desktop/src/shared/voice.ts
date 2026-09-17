/**
 * Voice input: speech is transcribed on this machine by Whisper, running in
 * the renderer on WebGPU or WebAssembly. The model files come from Hugging
 * Face once, through the main process, and live under the app home after.
 */

export const WHISPER_MODEL_ID = "onnx-community/whisper-base";
export const WHISPER_REMOTE_HOST = "https://huggingface.co/";

/** What the renderer gets back for one model file it asked for. */
export interface WhisperFileResult {
  /** 200 with bytes, 404 for a file the repo does not have, 502 otherwise. */
  status: number;
  data?: ArrayBuffer;
  error?: string;
}

export interface WhisperDownloadProgress {
  /** Path inside the model repo, e.g. `onnx/encoder_model_quantized.onnx`. */
  file: string;
  loadedBytes: number;
  totalBytes: number;
  done: boolean;
}

/** Sample rate Whisper's feature extractor expects. */
export const WHISPER_SAMPLE_RATE = 16_000;
