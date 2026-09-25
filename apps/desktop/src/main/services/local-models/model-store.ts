/**
 * The GGUF files on disk under `~/.abacusai-bot/models/`, and how they get
 * there: one streamed download per model, hashed on the way in and kept only
 * when the digest matches the catalog's pin. A download that stops halfway
 * leaves its `.part` behind and resumes from it next time. These files are
 * gigabytes, and a laptop lid closes.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  LOCAL_MODEL_CATALOG,
  localModelUrl,
  type LocalModelSpec,
} from "#shared/local-models";

import { abacusBotHome } from "../../paths";

export const modelsDir = (): string => path.join(abacusBotHome(), "models");

export const modelPath = (spec: LocalModelSpec): string =>
  path.join(modelsDir(), spec.file);

const partPath = (spec: LocalModelSpec): string => `${modelPath(spec)}.part`;

/** Whether the model's file is on disk at exactly the pinned size. */
export const isInstalled = (spec: LocalModelSpec): boolean => {
  try {
    return fs.statSync(modelPath(spec)).size === spec.sizeBytes;
  } catch {
    return false;
  }
};

export const installedModels = (): LocalModelSpec[] =>
  LOCAL_MODEL_CATALOG.filter(isInstalled);

export const removeModel = (spec: LocalModelSpec): void => {
  fs.rmSync(modelPath(spec), { force: true });
  fs.rmSync(partPath(spec), { force: true });
};

export interface DownloadOptions {
  onProgress: (receivedBytes: number, totalBytes: number) => void;
  signal: AbortSignal;
  /** Test seam: the fetch to download with. */
  fetchImpl?: typeof fetch;
  /** Test seam: the URL to download from. */
  url?: string;
}

const hashOf = (file: string, upTo: number): ReturnType<typeof createHash> => {
  const hash = createHash("sha256");
  const fd = fs.openSync(file, "r");
  try {
    const chunk = Buffer.alloc(1024 * 1024);
    let offset = 0;
    while (offset < upTo) {
      const read = fs.readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.length, upTo - offset),
        offset
      );
      if (read <= 0) break;
      hash.update(chunk.subarray(0, read));
      offset += read;
    }
  } finally {
    fs.closeSync(fd);
  }
  return hash;
};

/**
 * Download the model, resuming a partial file, and keep it only if its digest
 * is the pinned one. Resolves with the final path; throws on a mismatch (the
 * partial is discarded. Asking again until the digest matches is how a
 * download accepts the wrong file) or when `signal` aborts (the partial stays).
 */
export async function downloadModel(
  spec: LocalModelSpec,
  {
    onProgress,
    signal,
    fetchImpl = fetch,
    url = localModelUrl(spec),
  }: DownloadOptions
): Promise<string> {
  fs.mkdirSync(modelsDir(), { recursive: true });
  const part = partPath(spec);

  let received = 0;
  try {
    received = fs.statSync(part).size;
  } catch {
    received = 0;
  }
  // A partial larger than the file is not this file.
  if (received > spec.sizeBytes) {
    fs.rmSync(part, { force: true });
    received = 0;
  }

  const hash = received > 0 ? hashOf(part, received) : createHash("sha256");
  onProgress(received, spec.sizeBytes);

  if (received < spec.sizeBytes) {
    const response = await fetchImpl(url, {
      signal,
      redirect: "follow",
      headers: received > 0 ? { Range: `bytes=${received}-` } : {},
    });
    // A server that ignored the range starts over; a partial is only kept
    // when the answer continues it.
    if (received > 0 && response.status !== 206) {
      fs.rmSync(part, { force: true });
      return downloadModel(spec, { onProgress, signal, fetchImpl, url });
    }
    if (!response.ok || response.body == null) {
      throw new Error(
        `download failed with ${response.status} ${response.statusText}`
      );
    }

    const out = fs.createWriteStream(part, { flags: received > 0 ? "a" : "w" });
    try {
      const reader = response.body.getReader();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value == null) continue;
        hash.update(value);
        received += value.length;
        await new Promise<void>((resolve, reject) => {
          out.write(value, (error) => (error ? reject(error) : resolve()));
        });
        onProgress(received, spec.sizeBytes);
      }
    } finally {
      await new Promise<void>((resolve) => out.end(resolve));
    }
  }

  // A body that ended early is a connection dropped, not a wrong file: the
  // partial stays, and the next attempt asks for the rest.
  if (received < spec.sizeBytes) {
    throw new Error(
      `${spec.file}: the download ended after ${received} of ${spec.sizeBytes} bytes`
    );
  }

  const digest = hash.digest("hex");
  if (received !== spec.sizeBytes || digest !== spec.sha256) {
    fs.rmSync(part, { force: true });
    throw new Error(
      `${spec.file}: checksum mismatch: expected ${spec.sha256}, got ${digest} (${received} bytes)`
    );
  }

  fs.renameSync(part, modelPath(spec));
  return modelPath(spec);
}
