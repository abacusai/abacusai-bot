import { impl } from "./impl";

export const modelsRouter = impl.models.router({
  list: impl.models.list.handler(({ input, context }) =>
    context.deps.host.listModels(input?.refresh)
  ),
});
