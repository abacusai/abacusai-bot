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
  WHISPER_MODEL_FILES,
  WHISPER_MODEL_IDS,
  WHISPER_REMOTE_HOST,
  type WhisperFileResult,
  type WhisperModelId,
} from "@abacus-ai/contract/voice";

import { abacusBotHome } from "../../paths";

/** `https://huggingface.co/<repo>/resolve/main/<file>` → its model and file, or null. */
export const modelFileFor = (
  url: string
): { model: WhisperModelId; file: string } | null => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const href = `${parsed.origin}${parsed.pathname}`;
  const model = WHISPER_MODEL_IDS.find((id) =>
    href.startsWith(`${WHISPER_REMOTE_HOST}${id}/resolve/main/`)
  );
  if (model == null) return null;
  const file = decodeURIComponent(
    href.slice(`${WHISPER_REMOTE_HOST}${model}/resolve/main/`.length)
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
  return { model, file };
};

/** The Hugging Face URL of a validated model file: fixed origin, path only. */
const remoteUrl = (model: WhisperModelId, file: string): URL => {
  const url = new URL(WHISPER_REMOTE_HOST);
  url.pathname = `${model}/resolve/main/${file}`;
  return url;
};

export class WhisperModelService {
  private readonly downloads = new Map<
    string,
    Promise<WhisperFileResult & { path?: string }>
  >();

  constructor(
    private readonly options: {
      emitEvent: (event: IpcEvent) => void;
      /** Holds one directory per model id. */
      modelsDir?: string;
      fetch?: typeof fetch;
    } = { emitEvent: () => {} }
  ) {}

  modelDir(model: WhisperModelId): string {
    return path.join(
      this.options.modelsDir ?? path.join(abacusBotHome(), "models", "whisper"),
      model
    );
  }

  /** Whether every file the transcriber loads is on disk. */
  isCached(model: WhisperModelId): boolean {
    return WHISPER_MODEL_FILES.every((file) =>
      fs.existsSync(path.join(this.modelDir(model), file))
    );
  }

  /** True when the model is on disk; otherwise starts its download and answers false. */
  prepare(model: WhisperModelId): boolean {
    if (this.isCached(model)) return true;
    for (const file of WHISPER_MODEL_FILES) {
      // Failures surface again when the transcriber asks for the file.
      void this.prepareFile(remoteUrl(model, file).href);
    }
    return false;
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
    const match = modelFileFor(url);
    if (match == null) {
      return { status: 403, error: "Not a Whisper model file." };
    }
    const { model, file } = match;
    const root = path.resolve(this.modelDir(model));
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
    const key = `${model}/${file}`;
    let pending = this.downloads.get(key);
    if (pending == null) {
      pending = this.download(model, file, target).finally(() => {
        this.downloads.delete(key);
      });
      this.downloads.set(key, pending);
    }
    return pending;
  }

  private async download(
    model: WhisperModelId,
    file: string,
    target: string
  ): Promise<WhisperFileResult & { path?: string }> {
    const progress = (loaded: number, total: number, done: boolean): void => {
      this.options.emitEvent({
        type: "whisper-download-progress",
        progress: { model, file, loadedBytes: loaded, totalBytes: total, done },
        emittedAt: new Date().toISOString(),
      });
    };
    const doFetch = this.options.fetch ?? fetch;
    let response: Response;
    try {
      response = await doFetch(remoteUrl(model, file).href);
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
