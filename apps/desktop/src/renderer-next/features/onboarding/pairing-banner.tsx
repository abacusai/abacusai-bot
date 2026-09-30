import { useState } from "react";
import { useTranslation } from "react-i18next";

import { useDb } from "#next/data/db";
import { usePrefs } from "#next/data/db/prefs";
import { useAppNavigate } from "#next/lib/navigation/use-app-navigate";
import { Button } from "#next/ui/button";
/** The queue survives sign-in windows and reloads; acknowledging one entry drains only that entry. */
export const PairingQueueBanner = () => {
  const db = useDb();
  const prefs = usePrefs();
  const navigate = useAppNavigate();
  const { t } = useTranslation();
  const [busy, setBusy] = useState(false);
  const platform = prefs.onboardingPairing?.[0];
  if (!platform) return null;
  const drain = async (open: boolean) => {
    if (busy) return;
    setBusy(true);
    try {
      if (open)
        await navigate({
          href: `/library/messaging?platform=${encodeURIComponent(platform)}`,
        });
      await db.updatePrefs({
        onboardingPairing: (
          db.collections.prefs.get("app")?.onboardingPairing ?? []
        ).filter((id) => id !== platform),
      });
    } catch (error) {
      setBusy(false);
      throw error;
    }
    setBusy(false);
  };
  return (
    <aside
      role="status"
      className="bg-muted fixed right-4 bottom-4 z-40 flex items-center gap-3 rounded-xl border p-3 shadow-sm"
    >
      <p>{t("onboarding.pages.pairing", { platform })}</p>
      <Button disabled={busy} onClick={() => void drain(true)}>
        {t("onboarding.pages.finishPairing")}
      </Button>
      <Button variant="ghost" disabled={busy} onClick={() => void drain(false)}>
        {t("common.close")}
      </Button>
    </aside>
  );
};
