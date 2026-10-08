import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCollections, useDb } from "#renderer/data/db";
import {
  WhatsAppIntro as Intro,
  whatsappChatQuery,
  WhatsAppConnectDialog,
} from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";
import { showInfo } from "#renderer/lib/toast";

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

/**
 * The agent's WhatsApp card on the web: AbacusAI Bot's own number, linked in
 * a dialog, instead of the desktop's pairing. Null where the server offers none.
 */
export const useBotNumberConnect = (
  onConnected: (() => void) | undefined
): { connect(): void; dialog: ReactNode } | null => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const chat = useQuery({
    ...whatsappChatQuery(callApps),
    enabled: onConnected != null,
  });
  if (onConnected == null || !chat.data?.available) return null;
  const linked = () => {
    setOpen(false);
    showInfo(t("web.whatsappBot.connected"));
    onConnected();
  };
  return {
    connect: () => {
      if (chat.data?.status === "linked") onConnected();
      else setOpen(true);
    },
    dialog: (
      <WhatsAppConnectDialog
        callApps={callApps}
        open={open}
        onOpenChange={setOpen}
        onLinked={linked}
      />
    ),
  };
};
