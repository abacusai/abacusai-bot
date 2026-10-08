import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { useSearch, useLocation, useRouter } from "@tanstack/react-router";
import { useEffect, useState, useRef, type ReactNode } from "react";

import { useCollections, useDb } from "#renderer/data/db";
import {
  WhatsAppIntro as Intro,
  whatsappChatQuery,
} from "#renderer/features/onboarding/whatsapp";
import { callApps } from "#renderer/features/shell/connect/services";
import { useAppNavigate } from "#renderer/lib/navigation/use-app-navigate";

/** The first-run WhatsApp intro, decided from this account's prefs once they load. */
export const WhatsAppIntro = () => {
  const db = useDb();
  const { data } = useLiveQuery(useCollections().prefs);
  const row = data?.[0];
  const navigate = useAppNavigate();
  const router = useRouter();
  const location = useLocation();
  const [dismissed, setDismissed] = useState(false);
  const { connect } = useSearch({ from: "/_shell" });
  const chat = useQuery({
    ...whatsappChatQuery(callApps),
    enabled: row != null,
  });
  useEffect(() => {
    if (
      !dismissed &&
      row &&
      row.dismissals.whatsappIntroAt == null &&
      chat.data?.available &&
      chat.data.status !== "linked" &&
      connect == null
    )
      void navigate({
        search: (previous) => ({ ...previous, connect: "whatsapp" }),
        replace: true,
        transition: "none",
      });
  }, [dismissed, row, chat.data, connect, navigate]);
  if (row == null) return null;
  return (
    <Intro
      callApps={callApps}
      seen={connect !== "whatsapp"}
      open={connect === "whatsapp"}
      onOpenChange={(open) => {
        if (open) return;
        setDismissed(true);
        if (location.state.whatsappDialog && router.history.canGoBack())
          router.history.back();
        else
          void navigate({
            search: (previous) => ({ ...previous, connect: undefined }),
            replace: true,
            transition: "none",
          });
      }}
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
  const pending = useRef(false);
  const navigate = useAppNavigate();
  const chat = useQuery({
    ...whatsappChatQuery(callApps),
    enabled: onConnected != null,
  });
  useEffect(() => {
    if (pending.current && chat.data?.status === "linked") {
      pending.current = false;
      onConnected?.();
    }
  }, [chat.data?.status, onConnected]);
  if (onConnected == null || !chat.data?.available) return null;
  return {
    connect: () => {
      if (chat.data?.status === "linked") onConnected();
      else {
        pending.current = true;
        void navigate({
          search: (previous) => ({ ...previous, connect: "whatsapp" }),
          state: { whatsappDialog: true },
          transition: "none",
        });
      }
    },
    dialog: null,
  };
};
