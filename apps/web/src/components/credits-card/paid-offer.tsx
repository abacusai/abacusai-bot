import {
  type PaidCreditsOffer,
  planPrice,
} from "@abacus-ai/contract/billing-plan";
import { Check, Smartphone } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { Button } from "#renderer/ui/button";

/**
 * What a paid plan out of credits is offered, on every surface that says so:
 * the next plan up with its price and the server's own features, or, for a
 * plan billed by Apple or Google, where both are bought. Nothing named here
 * is the app's: prices and features come from billing_plan.
 */
export const PaidOfferDetails = ({
  offer,
  compact = false,
}: {
  offer: PaidCreditsOffer;
  /** A card's short form: the plan and its price, without the list. */
  compact?: boolean;
}) => {
  const { t, i18n } = useTranslation();
  if (offer.inMobileApp)
    return (
      <p
        className="text-muted-foreground flex items-start gap-2 text-sm"
        data-slot="paid-offer-mobile"
      >
        <Smartphone aria-hidden className="mt-0.5 size-4 shrink-0" />
        <span>{t("outcome.wall.paidMobile")}</span>
      </p>
    );
  const next = offer.next;
  if (next == null) return null;
  return (
    <div className="flex flex-col gap-1.5" data-slot="paid-offer">
      <p className="font-medium">
        {t("outcome.wall.paidOffer", {
          plan: next.planName,
          price: planPrice(t, next, i18n.language),
        })}
      </p>
      {!compact && next.features.length > 0 && (
        <ul className="flex flex-col gap-1">
          {next.features.map((feature) => (
            <li key={feature} className="flex gap-1.5">
              <Check
                aria-hidden
                className="text-primary mt-0.5 size-3.5 shrink-0"
              />
              <span>{feature}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
};

/**
 * The paid offer's buttons: Top up first (the credits run out every month,
 * so more of them is the usual way on), then the next plan. Neither for a
 * plan bought in the mobile app.
 */
export const PaidOfferButtons = ({
  offer,
  onTopUp,
  onNextPlan,
  className,
}: {
  offer: PaidCreditsOffer;
  onTopUp?(): void;
  onNextPlan?(): void;
  className?: string;
}) => {
  const { t } = useTranslation();
  if (offer.inMobileApp) return null;
  const topUp = offer.topUpUrl != null && onTopUp != null;
  const next = offer.next != null && onNextPlan != null;
  if (!topUp && !next) return null;
  return (
    <div className={cn("flex flex-wrap gap-2", className)}>
      {topUp && (
        <Button size="sm" data-action="top-up" onClick={onTopUp}>
          {t("creditsCard.topUpCta")}
        </Button>
      )}
      {next && (
        <Button
          size="sm"
          variant={topUp ? "secondary" : "default"}
          data-action="next-plan"
          onClick={onNextPlan}
        >
          {t("outcome.wall.upgradeCta", { plan: offer.next!.planName })}
        </Button>
      )}
    </div>
  );
};
