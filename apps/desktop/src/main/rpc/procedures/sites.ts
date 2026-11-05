import { impl, requireWindow } from "./impl";

export const sitesRouter = impl.sites.router({
  pack: impl.sites.pack.handler(({ input, context }) =>
    context.deps.serviceHost.packSite(input.sessionId, input.packId)
  ),
  progress: impl.sites.progress.handler(({ input, context }) =>
    context.deps.serviceHost.sitePackProgress(input.packId)
  ),
  cancel: impl.sites.cancel.handler(({ input, context }) => {
    context.deps.serviceHost.cancelSitePack(input.packId);
  }),
  startDrag: impl.sites.startDrag.handler(({ input, context }) => {
    context.deps.app.startFileDrag?.(requireWindow(context), input.path);
  }),
});
