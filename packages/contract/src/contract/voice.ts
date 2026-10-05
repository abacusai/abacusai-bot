import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { WhisperDownloadProgress, WhisperFileResult } from "../voice";
import { mutation, subscription } from "./base";
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
    progress: subscription
      .input(NoInput)
      .output(eventIterator(type<WhisperDownloadProgress>())),
  },
  /** macOS asks once; elsewhere this is always true. */
  requestMicrophone: mutation.input(NoInput).output(type<boolean>()),
};
