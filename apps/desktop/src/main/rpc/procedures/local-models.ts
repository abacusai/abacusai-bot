import type { LocalModelProgress } from "@abacus-ai/contract/local-models";

import { unavailable } from "../errors";
import { impl, isType, onIpcEvents, stream } from "./impl";

export const localModelsRouter = impl.localModels.router({
  state: impl.localModels.state.handler(({ context }) => {
    const state = context.deps.host.localModels.state();
    if (state == null) throw unavailable("The local model runtime is not up");
    return state;
  }),
  install: impl.localModels.install.handler(({ input, context }) =>
    context.deps.host.localModels.install(input.modelId)
  ),
  cancelInstall: impl.localModels.cancelInstall.handler(({ context }) => {
    context.deps.host.localModels.cancelInstall();
  }),
  remove: impl.localModels.remove.handler(({ input, context }) => {
    context.deps.host.localModels.remove(input.modelId);
  }),
  progress: impl.localModels.progress.handler(({ context, signal }) =>
    stream<LocalModelProgress>({
      path: "localModels.progress",
      context,
      signal,
      attach: onIpcEvents(context, isType("local-model-progress"), (event) =>
        event.type === "local-model-progress" ? event.progress : null
      ),
      // Each yield is the download's latest state.
      coalesceKey: () => "progress",
    })
  ),
});
