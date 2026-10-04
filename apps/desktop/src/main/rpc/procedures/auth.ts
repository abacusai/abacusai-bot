import { ORPCError } from "@orpc/server";

import { impl } from "./impl";

export const authRouter = impl.auth.router({
  web: {
    start: impl.auth.web.start.handler(() => {
      throw new ORPCError("UNSUPPORTED", {
        status: 501,
        data: { procedure: "auth.web.start" },
      });
    }),
    complete: impl.auth.web.complete.handler(() => {
      throw new ORPCError("UNSUPPORTED", {
        status: 501,
        data: { procedure: "auth.web.complete" },
      });
    }),
  },
  openRouter: {
    start: impl.auth.openRouter.start.handler(({ context }) =>
      context.deps.host.startOpenRouterAuth()
    ),
    cancel: impl.auth.openRouter.cancel.handler(({ context }) => {
      context.deps.host.cancelOpenRouterAuth();
    }),
  },
  abacus: {
    shouldAutoSignIn: impl.auth.abacus.shouldAutoSignIn.handler(({ context }) =>
      context.deps.host.shouldAutoSignIn()
    ),
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
