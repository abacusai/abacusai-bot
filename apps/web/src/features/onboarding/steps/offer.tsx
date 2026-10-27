import { planPrice, wallOffer } from "@abacus-ai/contract/billing-plan";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useEffectEvent, useRef, type Ref } from "react";
import { useTranslation } from "react-i18next";

import { startPlanCheckout } from "#renderer/lib/upgrade-dialog";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";

import { onboardingStore } from "../store";
import type { StepContext } from "./context";
import { StepBody, StepTitle } from "./kit";

/**
 * The plan offer at the end of onboarding, for the accounts the platform's
 * experiment put in its offer arm: the plan's price and whole pitch, read from
 * the billing plan, beside an equally weighted Start free. Either answer goes
 * on to the first-run screen; an account the plan read offers nothing (or a
 * failed read) goes on by itself, so the screen never holds anyone up.
 */
export const OfferStep = ({
  ctx,
  heading,
}: {
  ctx: StepContext;
  heading: Ref<HTMLHeadingElement>;
}) => {
  const { t, props, busy, advance } = ctx;
  const { transport } = props;
  const { i18n } = useTranslation();
  const billing = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    staleTime: 60_000,
    retry: false,
    enabled: props.preview !== true,
  });
  const offer = wallOffer(billing.data ?? null);
  const nothingToOffer =
    props.preview !== true &&
    (billing.isError || (billing.isSuccess && offer == null));
  const goOn = useEffectEvent(() => advance());
  useEffect(() => {
    if (nothingToOffer) goOn();
  }, [nothingToOffer]);
  const shown = useRef(false);
  useEffect(() => {
    if (offer == null || shown.current || props.preview === true) return;
    shown.current = true;
    void transport.client.system
      .funnelStep({ step: "onboarding_offer_shown" })
      .catch(() => {});
  }, [offer, props.preview, transport]);
  const answer = (upgrade: boolean) => {
    // Inside the click: the web build opens checkout's tab here. The plan
    // dialog then waits for the payment over the next screen.
    if (upgrade) startPlanCheckout(transport.client, "onboarding-offer");
    onboardingStore.setState((state) => ({ ...state, offerAnswered: true }));
    void transport.client.system
      .funnelStep({
        step: upgrade ? "onboarding_offer_upgrade" : "onboarding_offer_skip",
      })
      .catch(() => {});
    advance();
  };
  return (
    <>
      <StepTitle ref={heading} size="medium">
        {t("onboarding.offer.title")}
      </StepTitle>
      <StepBody className="mt-2">{t("onboarding.offer.body")}</StepBody>
      <div
        className="border-border mt-5 flex w-full max-w-[440px] flex-col gap-4 rounded-2xl border p-5 text-left"
        data-slot="onboarding-offer"
      >
        {offer != null ? (
          <div className="flex flex-col gap-1" data-slot="upgrade-price">
            <span className="text-lg font-bold tracking-[-0.01em]">
              {planPrice(t, offer, i18n.language)}
            </span>
            <span className="text-muted-foreground text-[13px]">
              {t("upgradeDialog.planLine", { plan: offer.planName })}
            </span>
          </div>
        ) : (
          <div aria-hidden className="flex flex-col gap-2">
            <Skeleton className="h-6 w-40" />
            <Skeleton className="h-4 w-56" />
            <Skeleton className="h-24 w-full" />
          </div>
        )}
        {props.planPitch?.(offer != null ? (billing.data ?? null) : null)}
      </div>
      <div className="mt-5 grid w-full max-w-[440px] grid-cols-2 gap-3">
        <Button
          className="h-10 text-sm font-semibold"
          disabled={busy || offer == null}
          onClick={() => answer(true)}
        >
          {offer != null
            ? t("outcome.wall.upgradeCta", { plan: offer.planName })
            : t("creditsCard.cta")}
        </Button>
        <Button
          variant="outline"
          className="h-10 text-sm font-semibold"
          disabled={busy}
          onClick={() => answer(false)}
        >
          {t("onboarding.offer.startFree")}
        </Button>
      </div>
    </>
  );
};
