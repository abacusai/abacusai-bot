import { GALLERY_BILLING } from "#renderer/components/credits-card/threshold-gallery";

import { CREDITS_CARD_FRAME, CreditsCardBody } from "./credits-card";
import type { CreditsCardContext } from "./credits-card-context";

/** The sidebar card at a share of the free plan's credits used. */
export const CREDITS_SIDEBAR_GALLERY_LEVELS = ["10", "50", "80", "95"] as const;
export type CreditsSidebarGalleryLevel =
  (typeof CREDITS_SIDEBAR_GALLERY_LEVELS)[number];

const GRANTED = 2000;

const CONTEXTS: Record<CreditsSidebarGalleryLevel, CreditsCardContext | null> =
  {
    "10": null,
    "50": {
      level: 50,
      project: "Invoice app",
      estimate: { count: 16, kind: "builds" },
    },
    "80": {
      level: 80,
      project: "Invoice app",
      estimate: { count: 5, kind: "builds" },
    },
    "95": {
      level: 95,
      project: "Invoice app",
      estimate: { count: 1, kind: "builds" },
    },
  };

/** The free plan's sidebar card, at the sidebar's width, for the gallery and its screenshots. */
export const CreditsSidebarGallery = ({
  level,
}: {
  level: CreditsSidebarGalleryLevel;
}) => (
  <div className="flex h-full items-end p-6">
    <div className="w-[var(--sidebar-w)] px-2" data-slot="credits-card-gallery">
      <aside data-slot="upgrade-promo" className={CREDITS_CARD_FRAME}>
        <CreditsCardBody
          held={false}
          web={false}
          granted={GRANTED}
          used={(GRANTED * Number(level)) / 100}
          streakLeft={0}
          routinesHeld={false}
          billing={GALLERY_BILLING}
          context={CONTEXTS[level]}
          onCta={() => undefined}
        />
      </aside>
    </div>
  </div>
);
