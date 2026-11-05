import { impl } from "./impl";

export const sharesRouter = impl.shares.router({
  preview: impl.shares.preview.handler(({ input, context }) =>
    context.deps.host.previewShare(input.path, input.lang)
  ),
  create: impl.shares.create.handler(({ input, context }) =>
    context.deps.host.createShare(input.path, input.lang)
  ),
  list: impl.shares.list.handler(({ context }) =>
    context.deps.host.listShares()
  ),
  remove: impl.shares.remove.handler(({ input, context }) =>
    context.deps.host.removeShare(input.shareId)
  ),
});
