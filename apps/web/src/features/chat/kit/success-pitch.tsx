/**
 * The success pitch's card (contract success-pitch.ts): under the latest
 * reply, right after a free account got a good result. What they got, the
 * plan's price and its whole pitch (the upgrade dialog's own list), Upgrade
 * (the dialog's checkout) and Not now. Main stamps the offer when the turn
 * closes; this shows it and keeps the answer.
 */
import {
  type BillingPlan,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import {
  creditAccountKey,
  pendingThreshold,
} from "@abacus-ai/contract/credit-thresholds";
import type { FunnelStep } from "@abacus-ai/contract/funnel";
import {
  SUCCESS_PITCH_MOMENT_COPY,
  type SuccessPitchCard as SuccessPitchCardState,
  type SuccessPitchLead,
  type SuccessPitchMoment,
  type SuccessPitchOffer,
  successPitchAllowed,
  underHalfOfFreeCredits,
} from "@abacus-ai/contract/success-pitch";
import { useQuery } from "@tanstack/react-query";
import { Sparkles, X } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { usePaymentRequired } from "#renderer/components/payment-required";
import { useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { creditsTier } from "#renderer/lib/credits";
import {
  startPlanCheckout,
  useUpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Button } from "#renderer/ui/button";

import {
  PlanPitchList,
  upgradeCtaLabel,
} from "../../upgrade-dialog/plan-pitch";
import { useChatView } from "./context";

export interface SuccessPitchCardProps {
  moment: SuccessPitchMoment;
  lead: SuccessPitchLead | null;
  /** The plan as billing_plan reads it; the card needs its offer. */
  billing: BillingPlan;
  onUpgrade(): void;
  onNotNow(): void;
}

export const SuccessPitchCard = ({
  moment,
  lead,
  billing,
  onUpgrade,
  onNotNow,
}: SuccessPitchCardProps) => {
  const { t, i18n } = useTranslation();
  const offer = wallOffer(billing);
  if (offer == null) return null;
  return (
    <div
      data-slot="success-pitch"
      data-moment={moment}
      className="relative my-2 flex w-full max-w-[520px] gap-3 rounded-xl border border-violet-200 bg-violet-50/70 p-3.5 pr-9 text-sm dark:border-violet-900/70 dark:bg-violet-950/30"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-violet-600 text-white"
      >
        <Sparkles className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">
            {t(SUCCESS_PITCH_MOMENT_COPY[moment])}
          </p>
          <p className="text-muted-foreground">
            {t("successPitch.line", { plan: offer.planName })}
          </p>
          <p className="font-semibold" data-slot="success-pitch-price">
            {planPrice(t, offer, i18n.language)}
          </p>
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-muted-foreground text-xs font-medium">
            {t("upgradeDialog.planTitle", { plan: offer.planName })}
          </p>
          <PlanPitchList billing={billing} lead={lead} />
        </div>
        <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
          <Button
            size="sm"
            className="bg-violet-600 text-white hover:bg-violet-700"
            data-action="upgrade"
            onClick={onUpgrade}
          >
            {upgradeCtaLabel(t, offer)}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            className="text-muted-foreground"
            data-action="not-now"
            onClick={onNotNow}
          >
            {t("upgradeDialog.notNow")}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-2 right-2 size-7"
        aria-label={t("upgradeDialog.close")}
        data-action="close"
        onClick={onNotNow}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
};

/**
 * The card for this chat's offer, under its latest reply while nothing runs.
 * Only for a free account under half its free grant, under the caps, and
 * never over another card: the upgrade dialog, a credit milestone card owed,
 * or the payment screen. A read-only view never shows it. Without the plan
 * it is not shown at all, rather than half a pitch.
 */
export const SuccessPitchRow = ({ active }: { active: boolean }) => {
  const { session, composer, slots } = useChatView();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const payment = usePaymentRequired();
  const now = useNow();
  const key = creditAccountKey(account);
  const mark = key != null ? prefs.successPitch?.[key] : undefined;
  // The gallery previews an offer of its own, and keeps no answer to it.
  const preview = slots.successPitchOffer != null;
  const offer: SuccessPitchOffer | null =
    slots.successPitchOffer ?? mark?.offer ?? null;
  const cards = prefs.dismissals.successPitchCards ?? {};
  const card = key != null ? cards[key] : undefined;
  const milestoneOwed =
    key != null &&
    pendingThreshold(
      prefs.creditThresholds?.[key],
      prefs.dismissals.creditThresholdCards?.[key]
    ) != null;
  const eligible =
    offer != null &&
    key != null &&
    offer.sessionId === session.threadId &&
    card?.answered !== offer.id &&
    composer.readOnly == null &&
    !active &&
    creditsTier(account) === "free" &&
    underHalfOfFreeCredits(account?.credits_used, account?.credits_granted) &&
    !milestoneOwed &&
    payment.data == null;
  // Once on screen it stays until answered; a new one waits for the caps.
  const visible =
    eligible &&
    (card?.shownOffer === offer.id ||
      (!upgradeAsked && successPitchAllowed(card, mark, now)));
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: visible,
    staleTime: 60_000,
  });
  const showing =
    visible && billing != null && wallOffer(billing) != null ? offer : null;

  const write = (next: SuccessPitchCardState): void => {
    if (preview) return;
    void db
      .updatePrefs({
        dismissals: { successPitchCards: { ...cards, [key!]: next } },
      })
      .catch(() => undefined);
  };
  const base = (): SuccessPitchCardState => ({
    shown: card?.shown ?? 0,
    lastShownAt: card?.lastShownAt ?? null,
    notNow: card?.notNow ?? 0,
    shownOffer: card?.shownOffer ?? null,
    answered: card?.answered ?? null,
  });
  const funnel = (step: FunnelStep, trigger: string): void => {
    if (preview) return;
    void transport.client.system
      .funnelStep({ step, detail: trigger })
      .catch(() => undefined);
  };
  const shown = useEffectEvent((seen: SuccessPitchOffer) => {
    if (card?.shownOffer === seen.id) return;
    funnel("success_pitch_shown", seen.trigger);
    const previous = base();
    write({
      ...previous,
      shown: previous.shown + 1,
      lastShownAt: Date.now(),
      shownOffer: seen.id,
    });
  });
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);

  if (showing == null || billing == null) return null;
  return (
    <SuccessPitchCard
      moment={showing.moment}
      lead={showing.lead}
      billing={billing}
      onUpgrade={() => {
        // Inside the click: the web build opens its checkout tab here.
        startPlanCheckout(transport.client, "success-pitch");
        funnel("success_pitch_upgrade", showing.trigger);
        write({ ...base(), answered: showing.id });
      }}
      onNotNow={() => {
        funnel("success_pitch_not_now", showing.trigger);
        const previous = base();
        write({
          ...previous,
          notNow: previous.notNow + 1,
          answered: showing.id,
        });
      }}
    />
  );
};
