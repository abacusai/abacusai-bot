import type { Transport } from "#renderer/data/transport";
import {
  reserveAuthorization,
  completeConnectorAuthorization,
} from "#renderer/lib/browser/authorization";
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
      const authorization = reserveAuthorization();
      button.disabled = true;
      void transport.client.connectors
        .connect({
          connectorId: "abacus-gmailuser",
          options: { hint: email, owner: "first-run" },
        })
        .then((outcome) =>
          completeConnectorAuthorization(
            transport.client,
            "abacus-gmailuser",
            outcome,
            authorization
          )
        )
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
          authorization.close();
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
    if (claim("abacusai-bot:onboarding.autoSignIn")) start();
    return;
  }
  if (!(await transport.client.auth.abacus.shouldAutoSignIn({}))) return;
  if (!claim("abacusai-bot:onboarding.autoSignIn")) return;
  await transport.client.system.funnelStep({ step: "auto_signin" });
  start();
};
