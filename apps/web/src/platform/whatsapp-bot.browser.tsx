import { useLiveQuery } from "@tanstack/react-db";

import { useCollections, useDb } from "#renderer/data/db";
import { WhatsAppIntro as Intro } from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";

/** The first-run WhatsApp intro, decided from this account's prefs once they load. */
export const WhatsAppIntro = () => {
  const db = useDb();
  const { data } = useLiveQuery(useCollections().prefs);
  const row = data?.[0];
  if (row == null) return null;
  return (
    <Intro
      callApps={callApps}
      seen={row.dismissals.whatsappIntroAt != null}
      markSeen={() =>
        db.updatePrefs({ dismissals: { whatsappIntroAt: Date.now() } })
      }
    />
  );
};
