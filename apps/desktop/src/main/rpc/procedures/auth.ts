import { impl } from "./impl";

export const authRouter = impl.auth.router({
  openRouter: {
    start: impl.auth.openRouter.start.handler(({ context }) =>
      context.deps.host.startOpenRouterAuth()
    ),
    cancel: impl.auth.openRouter.cancel.handler(({ context }) => {
      context.deps.host.cancelOpenRouterAuth();
    }),
  },
  abacus: {
    start: impl.auth.abacus.start.handler(({ input, context }) =>
      context.deps.host.startAbacusAuth(input?.intent, input?.browserProfileId)
    ),
    browserProfiles: impl.auth.abacus.browserProfiles.handler(({ context }) =>
      context.deps.host.listBrowserSignInProfiles()
    ),
    cancel: impl.auth.abacus.cancel.handler(({ context }) => {
      context.deps.host.cancelAbacusAuth();
    }),
    openInBrowser: impl.auth.abacus.openInBrowser.handler(({ context }) => {
      context.deps.host.openAbacusAuthInBrowser();
    }),
    signOut: impl.auth.abacus.signOut.handler(({ input, context }) =>
      context.deps.host.signOutAbacus(input)
    ),
  },
});
