/**
 * GitHub through the user's own `gh`: the switch that keeps every `gh`
 * call (PR chip, review tab) on or off, and, while on, what `gh` answers
 * where sessions run: signed in, signed out, or not installed.
 */
import type { GithubStatus } from "@abacus-ai/contract/contract/github";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslation } from "react-i18next";

import { SettingSwitch } from "#renderer/components/form-kit/controls";
import {
  GroupCard,
  SettingRow,
  StatePill,
} from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import { useMutation } from "#renderer/data/query-client";
import { errorText } from "#renderer/lib/error-text";
import { platformSystem } from "#renderer/lib/platform-system";
import { showFailure } from "#renderer/lib/toast";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

const GH_INSTALL_URL = "https://cli.github.com";

export const GithubSettings = () => {
  const { t } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const enabled = prefs.githubIntegration !== false;
  return (
    <GroupCard title={t("settings.github.title")}>
      <SettingRow
        id="githubIntegration"
        title={t("settings.github.integration")}
        detail={t("settings.github.integrationDetail")}
      >
        <SettingSwitch
          id="githubIntegration"
          checked={enabled}
          onCheckedChange={(githubIntegration) =>
            void update({ githubIntegration }).catch((e) => showFailure(e))
          }
        />
      </SettingRow>
      {enabled ? <GithubCliRow /> : null}
    </GroupCard>
  );
};

const GithubCliRow = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const cache = useQueryClient();
  const key = transport.orpc.github.status.queryKey({ input: {} });
  const status = useQuery(
    transport.orpc.github.status.queryOptions({ input: {} })
  );
  // A fresh probe, past main's 30 s cache: gh may have just been installed.
  const recheck = useMutation({
    mutationFn: () => transport.client.github.status({ refresh: true }),
    onSuccess: (value) => cache.setQueryData(key, value),
    meta: { errorToast: true },
  });
  const data = status.data;
  return (
    <SettingRow
      id="githubCli"
      title={t("settings.github.cli")}
      detail={data ? cliDetail(t, data) : undefined}
    >
      <StatePill
        tone={!data ? "neutral" : data.state === "ok" ? "success" : "warning"}
      >
        {t(
          !data
            ? status.isError
              ? "settings.github.state.error"
              : "settings.github.checking"
            : `settings.github.state.${data.state}`
        )}
      </StatePill>
      {data?.state === "missing" ? (
        <Button
          size="sm"
          onClick={() =>
            void platformSystem(transport.client).openExternal({
              url: GH_INSTALL_URL,
            })
          }
        >
          {t("settings.github.install")}
        </Button>
      ) : null}
      {data?.state !== "ok" ? (
        <Button
          size="sm"
          variant="secondary"
          disabled={recheck.isPending || status.isFetching}
          onClick={() => recheck.mutate()}
        >
          {t("settings.github.checkAgain")}
        </Button>
      ) : null}
    </SettingRow>
  );
};

const cliDetail = (
  t: ReturnType<typeof useTranslation>["t"],
  status: GithubStatus
): string | undefined => {
  switch (status.state) {
    case "ok":
      return [
        status.account
          ? t("settings.github.connectedAs", {
              account: status.account,
              host: status.host ?? "github.com",
            })
          : null,
        status.version ? `gh ${status.version}` : null,
      ]
        .filter(Boolean)
        .join(" · ");
    case "missing":
      return t("settings.github.missingDetail");
    case "unauthenticated":
      return t("settings.github.unauthenticatedDetail");
    case "error":
      // The CLI's own words are for the log.
      return errorText(status.message) ?? undefined;
    case "disabled":
      return undefined;
  }
};
