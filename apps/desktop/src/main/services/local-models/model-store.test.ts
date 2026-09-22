/**
 * Downloading a model file: streamed to a `.part`, hashed on the way, kept
 * only when the digest matches; resumed from the partial after an abort.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";

import type { LocalModelSpec } from "#shared/local-models";

import {
  downloadModel,
  installedModels,
  isInstalled,
  modelPath,
  removeModel,
} from "./model-store";

const BODY = Buffer.from(
  Array.from({ length: 200_000 }, (_, i) =>
    String.fromCharCode(33 + (i % 90))
  ).join("")
);

const spec: LocalModelSpec = {
  id: "tiny",
  label: "Tiny",
  repo: "test/tiny",
  file: "tiny.gguf",
  sha256: createHash("sha256").update(BODY).digest("hex"),
  sizeBytes: BODY.length,
  minMemoryBytes: 0,
};

let home: string;
let server: http.Server;
let url: string;
/** How many bytes the server sends before hanging up, or null for all. */
let cutAfter: number | null = null;
let requests: Array<string | undefined> = [];

beforeAll(async () => {
  server = http.createServer((request, response) => {
    requests.push(request.headers.range);
    const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? "");
    const from = range ? Number(range[1]) : 0;
    const slice = BODY.subarray(from);
    response.writeHead(range ? 206 : 200, {
      "content-length": String(slice.length),
      ...(range
        ? { "content-range": `bytes ${from}-${BODY.length - 1}/${BODY.length}` }
        : {}),
    });
    if (cutAfter != null && cutAfter < slice.length) {
      // Flushed, then dropped a moment later: the client has read the first
      // bytes before the connection dies, as a real drop-out looks.
      response.write(slice.subarray(0, cutAfter), () => {
        setTimeout(() => response.destroy(), 30);
      });
      return;
    }
    response.end(slice);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/tiny.gguf`;
});

afterAll(() => {
  server.close();
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "models-"));
  process.env.ABACUSAI_BOT_HOME = home;
  cutAfter = null;
  requests = [];
});

afterEach(() => {
  delete process.env.ABACUSAI_BOT_HOME;
  fs.rmSync(home, { recursive: true, force: true });
});

const download = (signal = new AbortController().signal) => {
  const seen: number[] = [];
  const done = downloadModel(spec, {
    url,
    signal,
    onProgress: (received) => seen.push(received),
  });
  return { done, seen };
};

describe("downloading a model", () => {
  it("streams the file in, verifies it and installs it", async () => {
    const { done, seen } = download();

    await expect(done).resolves.toBe(modelPath(spec));
    expect(fs.readFileSync(modelPath(spec)).equals(BODY)).toBe(true);
    expect(isInstalled(spec)).toBe(true);
    expect(seen.at(-1)).toBe(BODY.length);
    expect(fs.existsSync(`${modelPath(spec)}.part`)).toBe(false);
  });

  it("resumes a cut-off download from its partial, and verifies the whole", async () => {
    cutAfter = 70_000;
    await expect(download().done).rejects.toThrow();
    const part = `${modelPath(spec)}.part`;
    expect(fs.statSync(part).size).toBe(70_000);

    cutAfter = null;
    await expect(download().done).resolves.toBe(modelPath(spec));
    expect(requests.at(-1)).toBe("bytes=70000-");
    expect(fs.readFileSync(modelPath(spec)).equals(BODY)).toBe(true);
  });

  it("throws away a file whose digest is not the pinned one", async () => {
    const wrong = { ...spec, sha256: "0".repeat(64) };

    await expect(
      downloadModel(wrong, {
        url,
        signal: new AbortController().signal,
        onProgress: () => {},
      })
    ).rejects.toThrow(/checksum mismatch/);
    expect(fs.existsSync(modelPath(spec))).toBe(false);
    expect(fs.existsSync(`${modelPath(spec)}.part`)).toBe(false);
  });

  it("stops on abort and keeps the partial for next time", async () => {
    const controller = new AbortController();
    cutAfter = 150_000;
    const { done } = download(controller.signal);
    controller.abort();

    await expect(done).rejects.toThrow();
    expect(isInstalled(spec)).toBe(false);
  });

  it("knows what is installed by the file's size, and removes cleanly", async () => {
    await download().done;
    expect(installedModels().map((model) => model.id)).toEqual([]); // not in the catalog
    expect(isInstalled(spec)).toBe(true);

    fs.truncateSync(modelPath(spec), 10);
    expect(isInstalled(spec)).toBe(false);

    removeModel(spec);
    expect(fs.existsSync(modelPath(spec))).toBe(false);
  });
});
