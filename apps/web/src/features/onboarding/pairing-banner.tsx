import { isMessagingPlatformConnected } from "@abacus-ai/contract/messaging";
import { useQuery } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { Button } from "#renderer/ui/button";
/**
 * The persisted queue drains on connection or dismissal, and waits for the
 * tour. `messaging.events` keeps the snapshot fresh (the library's rule).
 */
export const PairingQueueBanner = ({
  suppressed = false,
}: {
  suppressed?: boolean;
}) => {
  const { transport } = useRouter().options.context;
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const platform = prefs.onboardingPairing?.[0];
  const options = transport.orpc.messaging.snapshot.queryOptions({ input: {} });
  const snapshot = useQuery({ ...options, enabled: IS_ELECTRON && !!platform });
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
  if (!IS_ELECTRON || !platform || suppressed) return null;
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
