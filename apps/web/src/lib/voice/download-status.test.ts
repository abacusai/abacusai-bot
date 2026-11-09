/**
 * The dictation download notice: progress per model that never goes back,
 * small named by the clip's language with its quick-mode note, base's
 * first-ever download unnamed, "ready" once the host says the model is on
 * disk, and silence after a failure.
 */
import {
  WHISPER_BASE_MODEL_ID,
  WHISPER_SMALL_MODEL_ID,
  type WhisperDownloadProgress,
  type WhisperModelId,
} from "@abacus-ai/contract/voice";
import { describe, expect, it } from "vitest";

import {
  type DownloadState,
  downloadView,
  EMPTY_DOWNLOAD,
  foldDownload,
} from "./download-status";

const event = (
  model: WhisperModelId,
  file: string,
  loadedBytes: number,
  totalBytes: number,
  extra: Partial<WhisperDownloadProgress> = {}
): WhisperDownloadProgress => ({
  model,
  file,
  loadedBytes,
  totalBytes,
  done: false,
  modelReady: false,
  ...extra,
});

const fold = (...events: WhisperDownloadProgress[]): DownloadState =>
  events.reduce(foldDownload, EMPTY_DOWNLOAD);

const FRENCH_QUICK = { language: "fr", quick: true };
const ENGLISH = { language: null, quick: false };

describe("dictation download notice", () => {
  it("names the clip's language and quick mode while small downloads", () => {
    const state = fold(
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/encoder_model_quantized.onnx",
        40,
        100
      ),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        44,
        100
      )
    );
    expect(downloadView(state, FRENCH_QUICK)).toEqual({
      kind: "downloading",
      percent: 42,
      language: "fr",
      quick: true,
    });
  });

  it("ignores compressed files sent without a size, and counts a weight not started as nothing", () => {
    const state = fold(
      event(WHISPER_SMALL_MODEL_ID, "tokenizer.json", 2_480_466, 0, {
        done: true,
      }),
      event(WHISPER_SMALL_MODEL_ID, "preprocessor_config.json", 339, 339, {
        done: true,
      }),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/encoder_model_quantized.onnx",
        50,
        100
      )
    );
    expect(downloadView(state, FRENCH_QUICK)).toMatchObject({ percent: 25 });
  });

  it("never shows a lower percentage when a later file joins the total", () => {
    const state = fold(
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/encoder_model_quantized.onnx",
        90,
        100
      ),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        0,
        200
      )
    );
    expect(downloadView(state, FRENCH_QUICK)).toMatchObject({ percent: 45 });
  });

  it("says nothing about language or quick mode for base's first download", () => {
    const state = fold(
      event(WHISPER_BASE_MODEL_ID, "onnx/encoder_model_quantized.onnx", 5, 10)
    );
    expect(downloadView(state, FRENCH_QUICK)).toEqual({
      kind: "downloading",
      percent: 25,
      language: null,
      quick: false,
    });
  });

  it("stays up between files and turns ready only when the host says so", () => {
    const between = fold(
      event(WHISPER_SMALL_MODEL_ID, "config.json", 1, 1, { done: true })
    );
    expect(downloadView(between, ENGLISH)).toMatchObject({
      kind: "downloading",
    });
    const ready = foldDownload(
      between,
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        9,
        9,
        {
          done: true,
          modelReady: true,
        }
      )
    );
    expect(downloadView(ready, FRENCH_QUICK)).toEqual({
      kind: "ready",
      language: "fr",
    });
  });

  it("stays silent after one file fails while another file's chunks keep arriving", () => {
    const failed = fold(
      event(WHISPER_SMALL_MODEL_ID, "onnx/encoder_model_quantized.onnx", 0, 90),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        0,
        150
      ),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/encoder_model_quantized.onnx",
        30,
        90,
        {
          done: true,
          failed: true,
        }
      ),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        60,
        150
      ),
      event(
        WHISPER_SMALL_MODEL_ID,
        "onnx/decoder_model_merged_quantized.onnx",
        90,
        150
      )
    );
    expect(downloadView(failed, FRENCH_QUICK)).toBeNull();
    // A new download of the failed file brings the notice back.
    const retried = foldDownload(
      failed,
      event(WHISPER_SMALL_MODEL_ID, "onnx/encoder_model_quantized.onnx", 0, 90)
    );
    expect(downloadView(retried, FRENCH_QUICK)).toMatchObject({
      kind: "downloading",
    });
  });

  it("is silent after a failed download and when nothing was downloading", () => {
    const failed = fold(
      event(WHISPER_SMALL_MODEL_ID, "onnx/encoder_model_quantized.onnx", 3, 9),
      event(WHISPER_SMALL_MODEL_ID, "onnx/encoder_model_quantized.onnx", 3, 9, {
        done: true,
        failed: true,
      })
    );
    expect(downloadView(failed, FRENCH_QUICK)).toBeNull();
    expect(downloadView(EMPTY_DOWNLOAD, FRENCH_QUICK)).toBeNull();
  });
});
