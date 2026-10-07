import type { ConnectorOutcome } from "@abacus-ai/contract/contracts";

import type { Transport } from "#renderer/data/transport";
import { waitForConnected } from "#renderer/lib/connect-page";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { openConnectPage } from "#renderer/lib/platform-system";

const claim = (key: string): boolean => {
  try {
    if (localStorage.getItem(key) != null) return false;
    localStorage.setItem(key, "started");
    return true;
  } catch {
    return false;
  }
};

/** Gmail's connect page for the signed-in address, then the wait for it to connect. */
const connectGmail = (
  transport: Transport,
  email: string
): Promise<ConnectorOutcome> =>
  (
    openConnectPage(transport.client, "abacus-gmailuser", { hint: email }) ??
    transport.client.connectors.connect({ connectorId: "abacus-gmailuser" })
  ).then((outcome) =>
    outcome.ok
      ? waitForConnected(
          transport.client,
          "abacus-gmailuser",
          new AbortController().signal
        )
      : outcome
  );

/** The account's Gmail consent outlives whichever onboarding page starts it. */
export const startFirstRunGmail = async (
  transport: Transport,
  email: string
): Promise<void> => {
  if (!email) return;
  if (!IS_ELECTRON) {
    const statuses = await transport.client.connectors.statuses({});
    if (
      statuses["abacus-gmailuser"]?.state === "connected" ||
      document.getElementById("gmail-consent")
    )
      return;
    const slot = document.getElementById("onboarding-consent");
    if (!slot) return;
    const banner = document.createElement("div");
    banner.className =
      "flex items-center justify-between gap-3 rounded-lg border p-3";
    banner.setAttribute("role", "status");
    const dismiss = document.createElement("button");
    dismiss.textContent = "Dismiss";
    dismiss.onclick = () => banner.remove();
    const button = document.createElement("button");
    button.id = "gmail-consent";
    button.className =
      "rounded-lg bg-primary px-4 py-2 text-primary-foreground";
    button.textContent = "Connect Gmail";
    button.onclick = () => {
      button.disabled = true;
      void connectGmail(transport, email)
        .then(async (outcome) => {
          await transport.client.system.funnelStep({
            step: outcome.ok ? "gmail_allowed" : "gmail_declined",
          });
          if (outcome.ok) {
            claim("abacusai-bot:onboarding.gmailHop");
            banner.remove();
          } else button.disabled = false;
        })
        .catch(() => {
          button.disabled = false;
        });
    };
    banner.append(button, dismiss);
    slot.append(banner);
    return;
  }
  const statuses = await transport.client.connectors.statuses({});
  if (
    statuses["abacus-gmailuser"]?.state === "connected" ||
    !claim("abacusai-bot:onboarding.gmailHop")
  )
    return;
  void connectGmail(transport, email)
    .then((outcome) =>
      transport.client.system.funnelStep({
        step: outcome.ok ? "gmail_allowed" : "gmail_declined",
      })
    )
    .catch(() => {});
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
