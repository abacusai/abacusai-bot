import { webSignOut } from "#renderer/lib/browser/sign-out";
import type { RouterContext } from "#renderer/router";

export const signOutAbacus = (
  context: RouterContext,
  _keepOtherApiKeys: boolean
) => webSignOut(context);
