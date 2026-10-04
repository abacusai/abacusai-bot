/**
 * Settings > General on the desktop: "Use from the web". Lets the AbacusAI
 * Bot web app's coding view run sessions, terminals and files on this
 * computer while the app is open (main/services/runner).
 */
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { SettingSwitch } from "#renderer/components/form-kit/controls";
import {
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { followNotices } from "#renderer/data/queries/live";
import { showError } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { isWebApp } from "#renderer/lib/web-app";
import type { WebRunnerState } from "#shared/contract";

const STATUS_KEY: Record<WebRunnerState["status"], string> = {
  off: "web.runner.off",
  "signed-out": "web.runner.off",
  connecting: "web.runner.connecting",
  connected: "web.runner.connected",
  unavailable: "web.runner.off",
};

export const WebRunnerSettings = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const [state, setState] = useState<WebRunnerState | null>(null);
  useEffect(() => {
    if (isWebApp) return;
    const abort = new AbortController();
    void transport.client.webRunner
      .state({})
      .then(setState)
      .catch(() => undefined);
    void followNotices(
      transport,
      ({ signal }) => transport.client.system.events({}, { signal }),
      (event) => {
        if (event.type === "web-runner") setState(event.state);
      },
      abort.signal
    );
    return () => abort.abort();
  }, [transport]);
  // The web app is what this setting serves; it has nothing to offer there.
  if (isWebApp) return null;
  return (
    <GroupCard>
      <SettingRow
        id="webRunner"
        title={t("web.runner.title")}
        detail={t("web.runner.description")}
      >
        {state?.enabled === true && (
          <StatePill
            tone={state.status === "connected" ? "success" : "neutral"}
          >
            {t(STATUS_KEY[state.status])}
          </StatePill>
        )}
        <SettingSwitch
          id="webRunner"
          checked={state?.enabled ?? false}
          disabled={state == null}
          onCheckedChange={(enabled) => {
            void transport.client.webRunner
              .setEnabled({ enabled })
              .then(setState)
              .catch(() => showError(t("phase5.saveFailed")));
          }}
        />
      </SettingRow>
    </GroupCard>
  );
};
