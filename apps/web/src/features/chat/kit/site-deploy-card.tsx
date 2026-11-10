/**
 * The deploy steps on a paid plan, right after a turn built a site: in the
 * success pitch's slot (a paid plan never gets the pitch), once per site
 * turn until closed. The paid welcome shows the same steps to a new payer.
 */
import { useEffect, useEffectEvent } from "react";

import { SiteDeployCardView } from "#renderer/components/site-deploy/deploy-card";
import { DeploySteps } from "#renderer/components/site-deploy/deploy-steps";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { payingAccount } from "#renderer/lib/upgrade";
import { useUpgradeDialogRequest } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";

import { useChatView } from "./context";
import { useTailCardClaim } from "./tail-cards";

/** Under the latest reply while nothing runs, on a paid plan, never over the upgrade dialog. */
export const SiteDeployCard = ({ active }: { active: boolean }) => {
  const { session, composer } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const sessionId = session.threadId;
  const mark = prefs.siteReady?.[sessionId];
  const cards = prefs.dismissals.siteDeployCards ?? {};
  const showing =
    IS_ELECTRON &&
    mark != null &&
    cards[sessionId] !== mark.turnId &&
    composer.readOnly == null &&
    !active &&
    !upgradeAsked &&
    payingAccount(account)
      ? mark
      : null;
  const funnel = (step: "site_deploy_shown" | "site_deploy_dismissed") =>
    void transport.client.system
      .funnelStep({ step, detail: "card" })
      .catch(() => undefined);
  const shown = useEffectEvent(() => funnel("site_deploy_shown"));
  const turnId = showing?.turnId ?? null;
  useEffect(() => {
    if (turnId != null) shown();
  }, [turnId]);
  useTailCardClaim(sessionId, turnId == null ? null : `site:${turnId}`);
  if (showing == null) return null;
  return (
    <SiteDeployCardView
      onClose={() => {
        funnel("site_deploy_dismissed");
        // The newest closed sessions only: one entry per chat.
        void db
          .updatePrefs({
            dismissals: {
              siteDeployCards: Object.fromEntries(
                [...Object.entries(cards), [sessionId, showing.turnId]].slice(
                  -20
                )
              ),
            },
          })
          .catch(() => undefined);
      }}
    >
      <DeploySteps
        sessionId={sessionId}
        turnId={showing.turnId}
        surface="card"
      />
    </SiteDeployCardView>
  );
};
