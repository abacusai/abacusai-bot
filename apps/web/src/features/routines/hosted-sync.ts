import type { RoutineRow } from "@abacus-ai/contract/contract/rows";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import type { TFunction } from "i18next";
import { useEffect } from "react";

import type { Transport } from "#renderer/data/transport";
import { platformSystem } from "#renderer/lib/platform-system";
import { showError, showInfo } from "#renderer/lib/toast";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";

import { routineRefusal } from "./refusal";

/** How often the open panel re-reads the hosted routines. */
const HOSTED_REFRESH_MS = 2 * 60_000;

/**
 * While the Routines panel is open: re-read the hosted routines now, on
 * window focus, and every 2 minutes, so a change made elsewhere shows.
 */
export const useHostedRefresh = (): void => {
  const { transport } = useAppContext();
  const cache = useQueryClient();
  useEffect(() => {
    const refresh = () =>
      void transport.client.routines
        .refreshHosted({})
        .then(({ hosted }) => {
          const key = transport.orpc.routines.runners.queryKey({ input: {} });
          const runners = cache.getQueryData<{ hosted: boolean }>(key);
          if (runners != null && runners.hosted !== hosted)
            void cache.invalidateQueries({ queryKey: key });
        })
        .catch(() => {});
    refresh();
    const timer = setInterval(refresh, HOSTED_REFRESH_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", refresh);
    };
  }, [transport, cache]);
};

/**
 * Whether the server has hosted routines switched off right now: they are
 * still listed, to pause or delete, but none runs.
 */
export const useHostedOff = (): boolean => {
  const { transport } = useAppContext();
  const runners = useQuery(
    transport.orpc.routines.runners.queryOptions({ input: {} })
  );
  return runners.data?.hosted === false;
};

/** A failed save, resume or pause, in words; the free plan's limits offer the upgrade. */
export const showSaveFailure = (
  error: unknown,
  transport: Transport,
  t: TFunction
): void => {
  const refusal = routineRefusal(error);
  if (refusal == null) {
    showError(t("phase5.failed"));
    return;
  }
  showError(
    t(refusal.key),
    refusal.upgrade
      ? {
          action: {
            label: t("routines.hosted.upgrade"),
            onClick: () =>
              void (refusal.upgradeUrl != null
                ? platformSystem(transport.client).openExternal({
                    url: refusal.upgradeUrl,
                  })
                : openUpgrade(transport.client)),
          },
        }
      : undefined
  );
};

/** Run a routine now; one waiting for the user's approval cannot run yet. */
export const runRoutineNow = (
  row: RoutineRow,
  transport: Transport,
  t: TFunction,
  trigger: "manual" | "create" = "manual"
): void => {
  if (row.hosted?.pendingConfirmation === true) {
    showInfo(t("routines.hosted.approveFirst"));
    return;
  }
  void transport.client.routines
    .run({ id: row.id, trigger })
    .then(() => {
      if (trigger === "manual") showInfo(t("phase5.routineStarted"));
    })
    .catch(() =>
      showError(
        t(trigger === "manual" ? "phase5.runFailed" : "phase5.firstRunFailed")
      )
    );
};
