import { eventIterator, type } from "@orpc/contract";
import * as v from "valibot";

import type { LocalModelInstallOutcome } from "../contracts";
import type { LocalModelProgress, LocalModelState } from "../local-models";
import { mutation, query, subscription } from "./base";
import { NoInput } from "./ids";

const ModelIdInput = v.object({ modelId: v.pipe(v.string(), v.nonEmpty()) });

export const localModels = {
  /** What this machine can run, what is installed and what is loading. */
  state: query.input(NoInput).output(type<LocalModelState>()),
  /** Resolves once the model can be picked as `local/<id>`; an outcome, not an error. */
  install: mutation
    .input(ModelIdInput)
    .output(type<LocalModelInstallOutcome>()),
  cancelInstall: mutation.input(NoInput).output(type<void>()),
  remove: mutation.input(ModelIdInput).output(type<void>()),
  /** Coalescing: each yield is the download's latest state. */
  progress: subscription
    .input(NoInput)
    .output(eventIterator(type<LocalModelProgress>())),
};
