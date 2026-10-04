import { useQuery } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import {
  CreditsCard,
  missingFreeSources,
} from "#renderer/components/credits-card";
import { creditActionsFor } from "#renderer/components/credits-card/actions";
import { GroupCard } from "#renderer/components/form-kit/page";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import {
  ABACUS_PLAN_URL,
  alternativeProviderLabels,
  creditMarkState,
  creditsCardState,
  creditsTier,
  joinProviderLabels,
} from "#renderer/lib/credits";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

const DISMISSED_KEY = "local-code:upsell-dismissed";
const readDismissed = () => {
  try {
    return localStorage.getItem(DISMISSED_KEY) != null;
  } catch {
    return false;
  }
};
export const SidebarCreditsCard = () => {
  const { transport } = useAppContext();
  const { t } = useTranslation();
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const navigate = useAppNavigate();
  const now = useNow();
  const [dismissed, setDismissed] = useState(readDismissed);
  const account = useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: { refresh: true } }),
    queryKey: [
      ...transport.orpc.account.abacus.queryKey({ input: { refresh: true } }),
      prefs.creditsExhaustedAt,
    ],
    staleTime: 60_000,
  });
  const models = useQuery(
    transport.orpc.models.list.queryOptions({ input: {} })
  );
  const keys = useQuery(
    transport.orpc.settings.keys.listProviders.queryOptions({ input: {} })
  );
  const local = useQuery(
    transport.orpc.localModels.state.queryOptions({ input: {} })
  );
  const mark = creditMarkState(
    account.data,
    prefs.creditsExhaustedAt,
    now,
    account.dataUpdatedAt >= (prefs.creditsExhaustedAt ?? Infinity)
  );
  useEffect(() => {
    if (mark === "clear")
      void update({ creditsExhaustedAt: null }).catch(() => {});
  }, [mark, update]);
  const state = creditsCardState(
    account.data,
    prefs.creditsExhaustedAt,
    dismissed,
    now
  );
  if (state == null) return null;
  const tier = creditsTier(account.data);
  const configured = Object.fromEntries(
    [
      ...(keys.data ?? []),
      ...(models.data ?? [])
        .filter((model) => model.configured)
        .map((model) => model.provider),
    ].map((provider) => [provider, true])
  );
  const alternatives = alternativeProviderLabels(configured);
  const canSwitch = tier === "free" && alternatives.length > 0;
  const canConnect =
    tier === "free" && !canSwitch && missingFreeSources(configured).length > 0;
  const canGoLocal =
    tier === "free" &&
    !canSwitch &&
    !canConnect &&
    local.data?.runtimeAvailable === true;
  const invite = (
    <Button
      variant="secondary"
      size="sm"
      onClick={() =>
        void navigate({
          to: "/settings/account",
          search: { invite: "link" },
          transition: "settings-in",
        })
      }
    >
      {t("creditsCard.inviteCta")}
    </Button>
  );
  return (
    <div className="mt-auto p-2" data-slot="sidebar-credits-card">
      {state === "upsell" ? (
        <GroupCard title={t("creditsCard.upsellTitle")}>
          <div className="flex flex-col gap-2 p-3">
            <Button
              size="sm"
              onClick={() =>
                void transport.client.system.openExternal({
                  url: ABACUS_PLAN_URL,
                })
              }
            >
              {t("creditsCard.cta")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                try {
                  localStorage.setItem(DISMISSED_KEY, "1");
                } catch {
                  /* Dismiss for this window if storage is unavailable. */
                }
                setDismissed(true);
              }}
            >
              {t("creditsCard.dismiss")}
            </Button>
          </div>
        </GroupCard>
      ) : tier === "paid" || canConnect ? (
        <CreditsCard
          host={creditActionsFor(transport)}
          tier={tier}
          {...(canConnect
            ? {
                title: t("creditsCard.title"),
                note: t("creditsCard.connectBody"),
                alternatives: invite,
              }
            : {})}
        />
      ) : (
        <GroupCard
          title={t(canSwitch ? "creditsCard.switchTitle" : "creditsCard.title")}
        >
          <div className="flex flex-col gap-2 p-3">
            <p className="text-muted-foreground text-sm">
              {canSwitch
                ? t("creditsCard.switchBody", {
                    providers: joinProviderLabels(
                      alternatives,
                      t("creditsCard.or")
                    ),
                  })
                : t(
                    canGoLocal
                      ? "creditsCard.localBody"
                      : "creditsCard.pickBody"
                  )}
            </p>
            {canGoLocal && (
              <>
                <Button
                  size="sm"
                  onClick={() =>
                    void navigate({
                      to: "/settings/models",
                      search: { provider: "local" },
                      transition: "settings-in",
                    })
                  }
                >
                  {t("localModels.useLocal")}
                </Button>
                {invite}
              </>
            )}
          </div>
        </GroupCard>
      )}
    </div>
  );
};
