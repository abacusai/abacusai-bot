/**
 * The Whisper model files the renderer's transcriber asks for. The renderer
 * cannot reach the network (its CSP allows only itself), so its model fetches
 * come here: a file is served from the app home when it is there, and
 * downloaded from Hugging Face with progress events when it is not.
 */
import fs from "fs";
import { createWriteStream } from "node:fs";
import { mkdir, rename, rm, readFile, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import path from "path";

import type { IpcEvent } from "@abacus-ai/contract/contracts";
import {
  WHISPER_MODEL_ID,
  WHISPER_REMOTE_HOST,
  type WhisperFileResult,
} from "@abacus-ai/contract/voice";

import { abacusBotHome } from "../../paths";

/** `https://huggingface.co/<repo>/resolve/main/<file>` → `<file>`, or null. */
export const modelFileFor = (url: string): string | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const prefix = `${WHISPER_REMOTE_HOST}${WHISPER_MODEL_ID}/resolve/main/`;
  if (!`${parsed.origin}${parsed.pathname}`.startsWith(prefix)) return null;
  const file = decodeURIComponent(
    `${parsed.origin}${parsed.pathname}`.slice(prefix.length)
  );
  // Inside the model directory only: plain relative segments, nothing that
  // starts with a dot, no backslash or drive colon (separators on Windows).
  const segments = file.split("/");
  if (
    segments.some(
      (segment) =>
        segment.length === 0 || segment.startsWith(".") || /[\\:]/.test(segment)
    )
  ) {
    return null;
  }
  return file;
};

export class WhisperModelService {
  private readonly downloads = new Map<
    string,
    Promise<WhisperFileResult & { path?: string }>
  >();

  constructor(
    private readonly options: {
      emitEvent: (event: IpcEvent) => void;
      modelDir?: string;
      fetch?: typeof fetch;
    } = { emitEvent: () => {} }
  ) {}

  modelDir(): string {
    return (
      this.options.modelDir ??
      path.join(abacusBotHome(), "models", "whisper", WHISPER_MODEL_ID)
    );
  }

  /** Whether the two weight files are on disk, so the UI can skip the wait. */
  isCached(): boolean {
    return [
      "onnx/encoder_model_quantized.onnx",
      "onnx/decoder_model_merged_quantized.onnx",
    ].every((file) => fs.existsSync(path.join(this.modelDir(), file)));
  }

  async fetchFile(url: string): Promise<WhisperFileResult> {
    const result = await this.prepareFile(url);
    if (result.status !== 200 || !result.path) return result;
    return { status: 200, data: toArrayBuffer(await readFile(result.path)) };
  }

  /** Resolve/download on disk; HTTP callers stream this path without reading model bytes into RPC. */
  async prepareFile(
    url: string,
    { download = true }: { download?: boolean } = {}
  ): Promise<WhisperFileResult & { path?: string }> {
    const file = modelFileFor(url);
    if (file == null) {
      return { status: 403, error: "Not a Whisper model file." };
    }
    const root = path.resolve(this.modelDir());
    const target = path.resolve(root, file);
    if (!target.startsWith(`${root}${path.sep}`)) {
      return { status: 403, error: "Not a Whisper model file." };
    }
    if (
      await stat(target).then(
        (entry) => entry.isFile(),
        () => false
      )
    ) {
      return { status: 200, path: target };
    }
    if (!download) return { status: 404 };
    // One download per file, however many callers ask while it is in flight.
    let pending = this.downloads.get(file);
    if (pending == null) {
      pending = this.download(file, target).finally(() => {
        this.downloads.delete(file);
      });
      this.downloads.set(file, pending);
    }
    return pending;
  }

  private async download(
    file: string,
    target: string
  ): Promise<WhisperFileResult & { path?: string }> {
    const progress = (loaded: number, total: number, done: boolean): void => {
      this.options.emitEvent({
        type: "whisper-download-progress",
        progress: { file, loadedBytes: loaded, totalBytes: total, done },
        emittedAt: new Date().toISOString(),
      });
    };
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(
        `${WHISPER_REMOTE_HOST}${WHISPER_MODEL_ID}/resolve/main/${file}`
      );
    } catch (error) {
      return {
        status: 502,
        error: error instanceof Error ? error.message : String(error),
      };
    }
    if (response.status === 404) return { status: 404 };
    if (!response.ok || response.body == null) {
      return { status: 502, error: `Hugging Face answered ${response.status}` };
    }
    const total = Number(response.headers.get("content-length") ?? 0);
    let loaded = 0;
    progress(0, total, false);
    const tmp = `${target}.${process.pid}.tmp`;
    try {
      await mkdir(path.dirname(target), { recursive: true });
      const chunks = async function* () {
        for await (const chunk of Readable.fromWeb(response.body! as never)) {
          loaded += chunk.byteLength;
          progress(loaded, total, false);
          yield chunk;
        }
      };
      await pipeline(Readable.from(chunks()), createWriteStream(tmp));
      await rename(tmp, target);
      progress(loaded, total, true);
      return { status: 200, path: target };
    } catch (error) {
      await rm(tmp, { force: true });
      progress(loaded, total, true);
      return {
        status: 502,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

const toArrayBuffer = (buffer: Buffer): ArrayBuffer =>
  buffer.buffer.slice(
    buffer.byteOffset,
    buffer.byteOffset + buffer.byteLength
  ) as ArrayBuffer;
