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

/** The account's consent hop outlives whichever onboarding page starts it. */
export const startFirstRunGmail = async (
  transport: Transport,
  email: string
): Promise<void> => {
  if (!email) return;
  const statuses = await transport.client.connectors.statuses({});
  if (
    statuses["abacus-gmailuser"]?.state === "connected" ||
    !claim("onboarding.gmailHop")
  )
    return;
  void transport.client.connectors
    .connect({
      connectorId: "abacus-gmailuser",
      options: { autostart: true, hint: email, owner: "first-run" },
    })
    .then((outcome) =>
      transport.client.system.funnelStep({
        step: outcome.ok ? "gmail_allowed" : "gmail_declined",
      })
    )
    .catch(() => {});
};

/** Once per install, so cancelling or signing out does not reopen the wall's hop. */
export const startWebsiteSignIn = async (
  transport: Transport,
  start: () => void
): Promise<void> => {
  if (!IS_ELECTRON) {
    start();
    return;
  }
  if (!(await transport.client.auth.abacus.shouldAutoSignIn({}))) return;
  if (!claim("onboarding.autoSignIn")) return;
  await transport.client.system.funnelStep({ step: "auto_signin" });
  start();
};
