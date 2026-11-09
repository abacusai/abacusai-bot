/**
 * Model files for the renderer's transcriber: only the Whisper repos are
 * served, a download lands on disk once, and progress is announced.
 */
import fs from "fs";
import os from "os";
import path from "path";

import type { IpcEvent } from "@abacus-ai/contract/contracts";
import {
  WHISPER_BASE_MODEL_ID,
  WHISPER_MODEL_FILES,
  WHISPER_SMALL_MODEL_ID,
} from "@abacus-ai/contract/voice";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { modelFileFor, WhisperModelService } from "./whisper-model-service";

const REPO = "https://huggingface.co/onnx-community/whisper-base/resolve/main/";
const SMALL_REPO =
  "https://huggingface.co/onnx-community/whisper-small/resolve/main/";

let dir: string;
let events: IpcEvent[];
let requests: string[];

const service = (
  respond: (url: string) => Response | Promise<Response>
): WhisperModelService =>
  new WhisperModelService({
    emitEvent: (event) => events.push(event),
    modelsDir: dir,
    fetch: async (input) => {
      requests.push(String(input));
      return respond(String(input));
    },
  });

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "whisper-"));
  events = [];
  requests = [];
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("which URLs are served", () => {
  it.each([
    [REPO, WHISPER_BASE_MODEL_ID],
    [SMALL_REPO, WHISPER_SMALL_MODEL_ID],
  ])("maps %s to its model and file", (repo, model) => {
    expect(modelFileFor(`${repo}onnx/encoder_model_quantized.onnx`)).toEqual({
      model,
      file: "onnx/encoder_model_quantized.onnx",
    });
  });

  it.each([
    ["another repo", "https://huggingface.co/other/model/resolve/main/x.onnx"],
    [
      "another Whisper size",
      "https://huggingface.co/onnx-community/whisper-large-v3/resolve/main/x",
    ],
    [
      "another host",
      "https://example.com/onnx-community/whisper-base/resolve/main/x",
    ],
    ["a path escape", `${REPO}../secrets.json`],
    ["an encoded path escape", `${REPO}onnx%2F..%2F..%2Fsecrets.json`],
    ["a dotfile", `${REPO}.git/config`],
    ["not a URL", "config.json"],
  ])("refuses %s", (_case, url) => {
    expect(modelFileFor(url)).toBeNull();
  });

  it("lets the URL parser fold a backslash walk back inside the repo", () => {
    // Chromium and Node both read `\` as `/` in an https URL and resolve the
    // `..` before this code sees it, so the walk never leaves the repo.
    expect(modelFileFor(`${REPO}onnx\\..\\secrets.json`)).toEqual({
      model: WHISPER_BASE_MODEL_ID,
      file: "secrets.json",
    });
  });

  it("answers 403 for anything outside the repo", async () => {
    const result = await service(() => new Response("x")).fetchFile(
      "https://example.com/x"
    );

    expect(result.status).toBe(403);
    expect(requests).toEqual([]);
  });
});

describe("downloading", () => {
  it("writes the file once and serves it from disk after", async () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const whisper = service(
      () =>
        new Response(bytes, {
          status: 200,
          headers: { "content-length": "4" },
        })
    );

    const first = await whisper.fetchFile(`${REPO}config.json`);
    const second = await whisper.fetchFile(`${REPO}config.json`);

    expect(first.status).toBe(200);
    expect(new Uint8Array(first.data!)).toEqual(bytes);
    expect(new Uint8Array(second.data!)).toEqual(bytes);
    expect(requests).toHaveLength(1);
    expect(
      fs.readFileSync(path.join(dir, WHISPER_BASE_MODEL_ID, "config.json"))
    ).toEqual(Buffer.from(bytes));
    const progress = events.flatMap((event) =>
      event.type === "whisper-download-progress" ? [event.progress] : []
    );
    expect(progress[0]).toMatchObject({
      model: WHISPER_BASE_MODEL_ID,
      file: "config.json",
      loadedBytes: 0,
    });
    expect(progress.at(-1)).toMatchObject({
      loadedBytes: 4,
      totalBytes: 4,
      done: true,
    });
  });

  it("passes a 404 through, so an optional file stays optional", async () => {
    const result = await service(
      () => new Response(null, { status: 404 })
    ).fetchFile(`${REPO}processor_config.json`);

    expect(result.status).toBe(404);
    expect(
      fs.existsSync(
        path.join(dir, WHISPER_BASE_MODEL_ID, "processor_config.json")
      )
    ).toBe(false);
  });

  it("reports a network failure without leaving a file behind", async () => {
    const result = await service(() => {
      throw new Error("offline");
    }).fetchFile(`${REPO}config.json`);

    expect(result).toEqual({ status: 502, error: "offline" });
    expect(events).toEqual([]);
    expect(fs.readdirSync(dir)).toEqual([]);
  });

  it("prepares a model once: downloads every file, then answers ready", async () => {
    const whisper = service(() => new Response(new Uint8Array([9])));

    expect(whisper.prepare(WHISPER_SMALL_MODEL_ID)).toBe(false);
    expect(whisper.prepare(WHISPER_SMALL_MODEL_ID)).toBe(false);
    await vi.waitFor(() => {
      expect(whisper.isCached(WHISPER_SMALL_MODEL_ID)).toBe(true);
    });

    expect(requests.sort()).toEqual(
      WHISPER_MODEL_FILES.map((file) => `${SMALL_REPO}${file}`).sort()
    );
    const progress = events.flatMap((event) =>
      event.type === "whisper-download-progress" ? [event.progress] : []
    );
    // Only the file that completes the set says the model is ready.
    expect(progress.filter((entry) => entry.modelReady)).toHaveLength(1);
    expect(progress.at(-1)).toMatchObject({ done: true, modelReady: true });
    expect(whisper.prepare(WHISPER_SMALL_MODEL_ID)).toBe(true);
    expect(whisper.isCached(WHISPER_BASE_MODEL_ID)).toBe(false);
  });
});
