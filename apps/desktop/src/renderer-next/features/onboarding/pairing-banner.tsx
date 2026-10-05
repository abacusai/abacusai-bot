import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { followNotices } from "#next/data/queries/live";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
import { isMessagingPlatformConnected } from "#shared/messaging";
/** The persisted queue drains on connection or dismissal, and waits for the tour. */
export const PairingQueueBanner = ({
  suppressed = false,
}: {
  suppressed?: boolean;
}) => {
  const { transport, queryClient } = useRouter().options.context;
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const platform = prefs.onboardingPairing?.[0];
  const options = transport.orpc.messaging.snapshot.queryOptions({ input: {} });
  const snapshot = useQuery({ ...options, enabled: !!platform });
  useEffect(() => {
    if (!platform) return;
    const abort = new AbortController();
    void followNotices(
      transport,
      ({ signal }) => transport.client.messaging.events({}, { signal }),
      () => {
        void queryClient.invalidateQueries({ queryKey: options.queryKey });
      },
      abort.signal
    );
    return () => abort.abort();
  }, [platform, transport, queryClient, options.queryKey]);
  useEffect(() => {
    if (
      platform &&
      snapshot.data &&
      isMessagingPlatformConnected(snapshot.data, platform)
    )
      void db
        .updatePrefs({
          onboardingPairing: (
            db.collections.prefs.get("app")?.onboardingPairing ?? []
          ).filter((id) => id !== platform),
        })
        .catch(() => undefined);
  }, [platform, snapshot.data, db]);
  if (!platform || suppressed) return null;
  const act = async (open: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (open)
        await navigate({
          href: `/library/messaging?platform=${encodeURIComponent(platform)}`,
        });
      else
        await db.updatePrefs({
          onboardingPairing: (
            db.collections.prefs.get("app")?.onboardingPairing ?? []
          ).filter((id) => id !== platform),
        });
    } catch {
      /* Keep the queued entry for retry. */
    }
    setBusy(false);
  };
  return (
    <aside
      role="status"
      className="bg-muted fixed right-4 bottom-4 z-40 flex items-center gap-3 rounded-xl border p-3 shadow-sm"
    >
      <p>{t("onboarding.pages.pairing", { platform })}</p>
      <Button disabled={busy} onClick={() => void act(true)}>
        {t("onboarding.pages.finishPairing")}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void act(false)}>
        {t("common.close")}
      </Button>
    </aside>
  );
};
