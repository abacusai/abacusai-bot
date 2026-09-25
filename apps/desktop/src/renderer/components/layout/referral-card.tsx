import { useNavigate } from "@tanstack/react-router";
import { useState, type JSX } from "react";
import { useTranslation } from "react-i18next";

import { useAbacusAccountQuery } from "../../hooks/use-abacus-account";
import { useReferralSummaryQuery } from "../../hooks/use-referrals";
import { durableStorage } from "../../lib/durable-storage";
import { creditsTier } from "./credits-exhausted-card";
import { UpsellCard } from "./upsell-card";

const DISMISSED_UNTIL_KEY = "referral-card.dismissed-until";
const DISMISS_FOR_MS = 7 * 24 * 60 * 60 * 1000;

const readDismissedUntil = (): number => {
  try {
    return Number(durableStorage.getItem(DISMISSED_UNTIL_KEY) ?? 0);
  } catch {
    return 0;
  }
};

/**
 * The sidebar's pitch for the invite loop: free and basic plans, until the
 * milestone is paid. Closing it rests it for a week, not forever: the
 * credits it offers are the answer to the wall these plans hit.
 */
export const ReferralCard = (): JSX.Element | null => {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { data: account } = useAbacusAccountQuery();
  const { data: summary } = useReferralSummaryQuery();
  const [dismissedUntil, setDismissedUntil] = useState(readDismissedUntil);

  const tier = creditsTier(account);
  if (tier === "unknown" || tier === "paid") return null;
  if (summary == null || summary.milestoneGranted) return null;
  if (dismissedUntil > Date.now()) return null;

  return (
    <UpsellCard
      dataId="sidebar-referral-card"
      title={t("referralCard.title", {
        credits: summary.milestoneCredits.toLocaleString(),
      })}
      body={t("referralCard.body", { count: summary.milestoneInvites })}
      cta={t("referralCard.cta")}
      onCta={() => {
        void navigate({ to: "/settings/referrals" });
      }}
      dismissLabel={t("referralCard.dismiss")}
      onDismiss={() => {
        const until = Date.now() + DISMISS_FOR_MS;
        try {
          durableStorage.setItem(DISMISSED_UNTIL_KEY, String(until));
        } catch {
          // A card that cannot remember being closed still closes.
        }
        setDismissedUntil(until);
      }}
    />
  );
};
