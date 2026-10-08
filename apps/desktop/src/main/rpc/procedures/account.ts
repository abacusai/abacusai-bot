import { impl } from "./impl";

export const accountRouter = impl.account.router({
  usage: impl.account.usage.handler(({ context }) =>
    context.deps.host.getUsageSnapshot()
  ),
  abacus: impl.account.abacus.handler(({ input, context }) =>
    context.deps.host.getAbacusAccount(input?.refresh)
  ),
  vaultUrl: impl.account.vaultUrl.handler(({ context }) =>
    context.deps.host.getVaultManageUrl()
  ),
  state: impl.account.state.handler(({ context }) =>
    context.deps.app.account.get()
  ),
  skipOnboarding: impl.account.skipOnboarding.handler(({ context }) =>
    context.deps.app.account.skip()
  ),
  signOut: impl.account.signOut.handler(({ context }) =>
    context.deps.app.account.signOut()
  ),
  forget: impl.account.forget.handler(({ context }) =>
    context.deps.app.account.forget()
  ),
});
