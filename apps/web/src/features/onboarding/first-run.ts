import type { Transport } from "#renderer/data/transport";
import { IS_ELECTRON } from "#renderer/lib/platform";

const claim = (key: string): boolean => {
  try {
    if (localStorage.getItem(key) != null) return false;
    localStorage.setItem(key, "started");
    return true;
  } catch {
    return false;
  }
};

/**
 * The browser arrives signed in to the website, so its host signs in with
 * that session whenever it is not signed in yet: once per page load (a
 * remount or a failed attempt never loops), for every account this browser
 * uses. Never once per browser: a second account would meet the sign-up wall.
 */
let webSignInStarted = false;

/** Whether this page load's browser hand-off has started (the welcome offers Try again after). */
export const websiteSignInStarted = (): boolean => webSignInStarted;

/**
 * Desktop: once per install, so cancelling or signing out does not reopen
 * the wall's hop. Browser: see `webSignInStarted`.
 */
export const startWebsiteSignIn = async (
  transport: Transport,
  start: () => void
): Promise<void> => {
  if (!IS_ELECTRON) {
    if (webSignInStarted) return;
    webSignInStarted = true;
    start();
    return;
  }
  if (!(await transport.client.auth.abacus.shouldAutoSignIn({}))) return;
  if (!claim("abacusai-bot:onboarding.autoSignIn")) return;
  await transport.client.system.funnelStep({ step: "auto_signin" });
  start();
};
