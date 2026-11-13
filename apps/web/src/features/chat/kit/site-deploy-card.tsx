/**
 * The paid card under a reply that left something on: a site gets its deploy
 * steps ("Deploy your site"); a server, a bot or a routine gets "Keep it
 * running 24/7", moving it to Abacus AI Agent on the web. In the success
 * pitch's slot (a paid plan never gets the pitch), once per thing until
 * closed. The paid welcome shows the same steps to a new payer.
 */
import {
  markClosed,
  markKind,
  markThing,
} from "@abacus-ai/contract/site-deploy";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { SiteDeployCardView } from "#renderer/components/site-deploy/deploy-card";
import { DeploySteps } from "#renderer/components/site-deploy/deploy-steps";
import {
  KeepSteps,
  keepTitle,
} from "#renderer/components/site-deploy/keep-steps";
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
  const { t } = useTranslation();
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
    !markClosed(cards[sessionId], mark) &&
    composer.readOnly == null &&
    !active &&
    !upgradeAsked &&
    payingAccount(account)
      ? mark
      : null;
  const kind = showing != null ? markKind(showing) : null;
  // A site keeps its own events; the rest are "keep it running".
  const detail = kind === "site" ? "card" : "keep_running";
  const funnel = (step: "site_deploy_shown" | "site_deploy_dismissed") =>
    void transport.client.system
      .funnelStep({ step, detail })
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
      title={kind === "site" ? undefined : keepTitle(t, showing)}
      body={kind === "site" ? undefined : t("keepRunning.paidLine")}
      onClose={() => {
        funnel("site_deploy_dismissed");
        // The newest closed sessions only: one entry per chat, the thing it was for.
        void db
          .updatePrefs({
            dismissals: {
              siteDeployCards: Object.fromEntries(
                [
                  ...Object.entries(cards).filter(([id]) => id !== sessionId),
                  [sessionId, markThing(showing)],
                ].slice(-20)
              ),
            },
          })
          .catch(() => undefined);
      }}
    >
      {kind === "site" ? (
        <DeploySteps
          sessionId={sessionId}
          turnId={showing.turnId}
          surface="card"
        />
      ) : (
        <KeepSteps
          sessionId={sessionId}
          mark={showing}
          surface="keep_running"
        />
      )}
    </SiteDeployCardView>
  );
};
