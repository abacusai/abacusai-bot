import "./send-hint.css";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { CoachCard } from "#renderer/components/coach-card";

import type { StartDraft } from "./start-session";

/**
 * The first-run sample waits in the box: Send pulses and a card above it says
 * to press it. Shown while `active`; closing the card ends it for good.
 */
export const SendHint = ({
  active,
  starters,
  onDismiss,
}: {
  active: boolean;
  starters: StartDraft["starters"];
  onDismiss(): void;
}) => {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const element = active
      ? document.querySelector<HTMLElement>(
          '[data-slot="sessions-start"] [data-slot="composer-send"]'
        )
      : null;
    const frame = requestAnimationFrame(() => setAnchor(element));
    element?.setAttribute("data-send-hint", "");
    return () => {
      cancelAnimationFrame(frame);
      element?.removeAttribute("data-send-hint");
    };
  }, [active]);
  if (!active || anchor == null) return null;
  return (
    <CoachCard
      anchor={anchor}
      // Below Send, so the sample stays readable; it flips up where there is no room.
      side="bottom"
      align="end"
      title={t("sessions.start.sendHint.title")}
      body={t(
        starters === "code"
          ? "sessions.start.sendHint.code"
          : "sessions.start.sendHint.build"
      )}
      onDismiss={onDismiss}
      marker={{ "data-send-hint-card": starters ?? "none" }}
    />
  );
};
