import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import {
  type DictationLanguage,
  WHISPER_MODEL_IDS,
  type WhisperDownloadProgress,
  type WhisperFileResult,
} from "../voice";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

/** `WhisperFileResult` with its bytes as a `Uint8Array`, which the wire carries. */
export type WhisperFile = Omit<WhisperFileResult, "data"> & {
  data?: Uint8Array;
};

export const voice = {
  whisper: {
    /** One model file by its Hugging Face URL, from disk or the network. */
    fetch: mutation
      .input(v.object({ url: v.pipe(v.string(), v.url()) }))
      .output(type<WhisperFile>()),
    /** Whether a model is on disk; when not, its download starts in the background. */
    prepare: mutation
      .input(v.object({ model: v.picklist(WHISPER_MODEL_IDS) }))
      .output(type<boolean>()),
    progress: subscription
      .input(NoInput)
      .output(eventIterator(type<WhisperDownloadProgress>())),
  },
  /** The user's language, which breaks a tie in the spoken language. */
  language: query.input(NoInput).output(type<DictationLanguage>()),
  /** macOS asks once; elsewhere this is always true. */
  requestMicrophone: mutation.input(NoInput).output(type<boolean>()),
};
