import {
  type BillingPlan,
  formatUsd,
  paidCreditsOffer,
  paidUpgradeOnly,
  planPitch,
  type UpgradeSrc,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { Check, CirclePause, Cpu, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { ChatCard } from "#renderer/components/chat-card";
import { UpgradeSeen } from "#renderer/components/upgrade-seen";
import { ABACUS_BUY_CREDITS_URL } from "#renderer/lib/abacus-links";
import { Button } from "#renderer/ui/button";

import type { CreditActions } from "./index";
import { PaidOfferButtons, PaidOfferDetails } from "./paid-offer";

/** Why the picked model cannot serve the turn, as the agent named it. */
export type ModelUnavailableKind = "retired" | "down" | "plan";

/**
 * The plan on offer and its whole pitch, from billing_plan: what every card
 * for a free account out of Abacus credits shows, never a shorter list.
 */
export const OfferPitch = ({ billing }: { billing: BillingPlan | null }) => {
  const { t, i18n } = useTranslation();
  const offer = wallOffer(billing);
  if (offer == null) return null;
  return (
    <div className="flex flex-col gap-1.5" data-slot="wall-offer">
      <p className="font-medium">
        {t("outcome.unavailable.offer", { plan: offer.planName })}
      </p>
      <ul className="flex flex-col gap-1">
        {planPitch(t, billing, i18n.language).map((feature) => (
          <li key={feature} className="flex gap-1.5">
            <Check
              aria-hidden
              className="text-primary mt-0.5 size-3.5 shrink-0"
            />
            <span>{feature}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};

/**
 * The plan's Upgrade with its price, and See plans beside it. `src` names the
 * surface, which counts it as shown (UpgradeSeen), once per `item` if given.
 */
export const OfferButtons = ({
  billing,
  src,
  item,
  onUpgrade,
  onSeePlans,
}: {
  billing: BillingPlan | null;
  src: UpgradeSrc;
  item?: string;
  onUpgrade(): void;
  onSeePlans(): void;
}) => {
  const { t, i18n } = useTranslation();
  const offer = wallOffer(billing);
  const first = offer?.firstMonthPriceCents;
  const monthly = offer?.priceCents;
  return (
    <>
      <UpgradeSeen src={src} {...(item != null && { item })} />
      <Button size="sm" data-action="upgrade" onClick={onUpgrade}>
        {first != null && monthly != null && first < monthly
          ? t("outcome.unavailable.upgradeIntro", {
              price: formatUsd(first, i18n.language),
            })
          : monthly != null
            ? t("outcome.unavailable.upgradeMonthly", {
                price: formatUsd(monthly, i18n.language),
              })
            : offer != null
              ? t("outcome.wall.upgradeCta", { plan: offer.planName })
              : t("creditsCard.cta")}
      </Button>
      <Button
        size="sm"
        variant="secondary"
        data-action="see-plans"
        onClick={onSeePlans}
      >
        {t("outcome.unavailable.seePlans")}
      </Button>
    </>
  );
};

/**
 * Any failure's way on once the Abacus credits are used up (the agent's
 * `plan-offer`): the plan's whole offer, priced, with Upgrade and See plans;
 * a paid plan's own offer (its top-up and next plan; Basic's next plan as the
 * free plan's is shown). The same pieces the cards above show.
 */
export const PlanOffer = ({
  host,
  paid,
  onUpgrade,
  onTopUp,
  onNextPlan,
}: {
  host: CreditActions;
  paid: boolean;
  onUpgrade(): void;
  onTopUp?(): void;
  onNextPlan?(): void;
}) => {
  const { t } = useTranslation();
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  useEffect(() => {
    let live = true;
    void host
      .billingPlan?.()
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  const paidOffer = paid ? paidCreditsOffer(billing) : null;
  const upgradeOnly = paidUpgradeOnly(paidOffer);
  if (paid && !upgradeOnly)
    return (
      <div className="flex flex-col gap-3 text-sm" data-slot="plan-offer">
        <p>{t("outcome.unavailable.creditsOutPaid")}</p>
        {paidOffer != null && (
          <>
            <PaidOfferDetails offer={paidOffer} />
            <PaidOfferButtons
              offer={paidOffer}
              {...(onTopUp != null && { onTopUp })}
              {...(onNextPlan != null && { onNextPlan })}
            />
          </>
        )}
      </div>
    );
  return (
    <div className="flex flex-col gap-3 text-sm" data-slot="plan-offer">
      <p>
        {t(
          upgradeOnly
            ? "outcome.unavailable.creditsOutPaid"
            : "outcome.unavailable.creditsOut"
        )}
      </p>
      <OfferPitch billing={billing} />
      <div className="flex flex-wrap items-center gap-1.5">
        <OfferButtons
          billing={billing}
          src="chat_credits"
          onUpgrade={onUpgrade}
          onSeePlans={() =>
            void (upgradeOnly && host.openNextPlan != null
              ? host.openNextPlan()
              : host.openUpgrade("chat_credits"))
          }
        />
      </div>
    </div>
  );
};

/**
 * The one card for a model the user picked that cannot serve the turn: what
 * failed and why, then RouteLLM - Open while Abacus credits are left (the
 * user's choice, never a silent switch) or the plan once they are used up;
 * a paid plan's top-up and next plan up. Prices, credits and features come
 * from billing_plan.
 */
export const ModelUnavailableCard = ({
  host,
  kind,
  label,
  title,
  why,
  creditsOut,
  paid = false,
  onSwitch,
  onPickModel,
  onUpgrade,
  upgradeSrc = "model_locked",
  onTopUp,
  onNextPlan,
}: {
  host: CreditActions;
  kind: ModelUnavailableKind;
  label: string;
  /** What failed, when the caller names it (a model off Abacus): in place of the kind's title. */
  title?: string;
  /** Why it failed, in place of the kind's reason. */
  why?: string;
  creditsOut: boolean;
  /** The account is on a paid plan: credits out offers its paid offer (Basic: the next plan, as free's pitch). */
  paid?: boolean;
  /** Re-sends the kept message on RouteLLM - Open. */
  onSwitch?(): void;
  /** Opens the model picker of the chat this card is in. */
  onPickModel?(from: HTMLElement): void;
  /** The upgrade dialog that resumes the turn. */
  onUpgrade?(): void;
  /** The surface its Upgrade counts as, the same one `onUpgrade`'s dialog is asked with. */
  upgradeSrc?: UpgradeSrc;
  /** A paid plan's Top up and next plan, with the dialog that resumes the turn. */
  onTopUp?(): void;
  onNextPlan?(): void;
}) => {
  const { t, i18n } = useTranslation();
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  const [canTopUp, setCanTopUp] = useState(false);
  const paidOut = paid && creditsOut;
  useEffect(() => {
    let live = true;
    void host
      .billingPlan?.()
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    // A paid plan out of credits only: no other card asks.
    if (paidOut)
      void host
        .canTopUpCredits?.()
        .then((value) => {
          if (live) setCanTopUp(value);
        })
        .catch(() => {});
    return () => {
      live = false;
    };
  }, [host, paidOut]);
  const offer = wallOffer(billing);
  const paidOffer = paidOut ? paidCreditsOffer(billing) : null;
  // The next plan alone (Basic): the free plan's credits-out card, its plan.
  const upgradeOnly = paidUpgradeOnly(paidOffer);
  const topUp =
    onTopUp ??
    (() =>
      void (host.openTopUp != null
        ? host.openTopUp()
        : host.openExternal(ABACUS_BUY_CREDITS_URL)));
  const nextPlan =
    onNextPlan ??
    (host.openNextPlan != null ? () => void host.openNextPlan?.() : undefined);
  const remaining = billing?.current.creditsRemaining;
  const upgrade = () =>
    onUpgrade != null
      ? onUpgrade()
      : upgradeOnly && nextPlan != null
        ? nextPlan()
        : void host.openUpgrade(upgradeSrc);
  const plan = kind === "plan" && !creditsOut;
  const Icon = kind === "plan" ? Lock : Cpu;
  const seePlans = () =>
    void (upgradeOnly && host.openNextPlan != null
      ? host.openNextPlan()
      : host.openUpgrade(upgradeSrc));
  return (
    <div data-slot="credits-card" data-variant="model-unavailable">
      <ChatCard
        icon={<Icon />}
        title={
          title ?? t(`outcome.unavailable.title.${kind}`, { model: label })
        }
      >
        <div
          className="flex flex-col gap-3 p-3 text-sm"
          data-slot="model-unavailable"
        >
          {paidOut && !upgradeOnly ? (
            <>
              <p>{t("outcome.unavailable.creditsOutPaid")}</p>
              {paidOffer != null && <PaidOfferDetails offer={paidOffer} />}
            </>
          ) : creditsOut ? (
            <>
              {why != null && <p>{why}</p>}
              <p>
                {t(
                  upgradeOnly
                    ? "outcome.unavailable.creditsOutPaid"
                    : "outcome.unavailable.creditsOut"
                )}
              </p>
              <OfferPitch billing={billing} />
            </>
          ) : plan ? (
            <>
              <p>
                {offer != null
                  ? t("outcome.unavailable.planBody", { plan: offer.planName })
                  : t("outcome.unavailable.planBodyAny")}
              </p>
              <OfferPitch billing={billing} />
            </>
          ) : (
            <p>
              {why ?? t(`outcome.unavailable.why.${kind}`)}{" "}
              {t("outcome.unavailable.kept")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 p-3">
          {paidOut && !upgradeOnly ? (
            paidOffer != null ? (
              <PaidOfferButtons
                offer={paidOffer}
                onTopUp={topUp}
                {...(nextPlan != null && { onNextPlan: nextPlan })}
              />
            ) : (
              canTopUp && (
                <Button
                  size="sm"
                  data-action="top-up"
                  className="self-start"
                  onClick={topUp}
                >
                  {t("creditsCard.topUpCta")}
                </Button>
              )
            )
          ) : creditsOut ? (
            <OfferButtons
              billing={billing}
              src={upgradeSrc}
              onUpgrade={upgrade}
              onSeePlans={seePlans}
            />
          ) : (
            <>
              {onSwitch != null && (
                <Button
                  size="sm"
                  data-action="switch-to-abacus"
                  onClick={onSwitch}
                >
                  {t("outcome.unavailable.switch")}
                </Button>
              )}
              {plan ? (
                <OfferButtons
                  billing={billing}
                  src={upgradeSrc}
                  onUpgrade={upgrade}
                  onSeePlans={seePlans}
                />
              ) : (
                onPickModel != null && (
                  <Button
                    size="sm"
                    variant="secondary"
                    data-action="switch-model"
                    onClick={(event) => onPickModel(event.currentTarget)}
                  >
                    {t("outcome.unavailable.pickModel")}
                  </Button>
                )
              )}
            </>
          )}
          {!plan && remaining != null && (
            <p
              className="text-muted-foreground text-xs"
              data-slot="credits-left"
            >
              {t("outcome.unavailable.creditsLeft", {
                credits: new Intl.NumberFormat(i18n.language).format(
                  Math.max(0, Math.round(remaining))
                ),
              })}
            </p>
          )}
        </div>
      </ChatCard>
    </div>
  );
};

/** Where the account stands when Google cut the reply off. */
export type CutOffState = "credits" | "out" | "held" | "signed-out";

/** What the person chose on the cut-off card, once the turn went on. */
export type CutOffResolution =
  | "continued"
  | "switched-chat"
  | "switched-bot"
  | "upgraded";

const RESOLVED_KEY: Record<CutOffResolution, string> = {
  continued: "outcome.cutoff.resolved.continued",
  "switched-chat": "outcome.cutoff.resolved.switchedChat",
  "switched-bot": "outcome.cutoff.resolved.switchedBot",
  upgraded: "outcome.cutoff.resolved.upgraded",
};

/**
 * The model-unavailable card for a reply Google cut off on the model the
 * user picked, after the app already asked once more. What arrived stays in
 * the chat above. The way on is the user's click, never a switch made for
 * them: RouteLLM - Open while Abacus credits are left, the phone check while
 * they are held, the plan (its dialog, never a price here) or, on a paid
 * plan, its paid offer once they are used up (Basic: the next plan, as the
 * free plan's is shown); Continue goes on the same model until the session's
 * second cut. Chosen, the card shrinks to one line saying what happened.
 */
export const CutOffCard = ({
  host,
  state,
  paid,
  streamed,
  label,
  resolved,
  onSwitch,
  onContinue,
  onPickModel,
  onUpgrade,
  onTopUp,
  onNextPlan,
  onVerify,
}: {
  host: CreditActions;
  state: CutOffState;
  paid: boolean;
  /** Part of the reply arrived and is kept above. */
  streamed: boolean;
  /** The picked model, by name. */
  label: string;
  resolved: CutOffResolution | null;
  onSwitch?(): void;
  onContinue?(): void;
  onPickModel?(from: HTMLElement): void;
  onUpgrade?(): void;
  onTopUp?(): void;
  onNextPlan?(): void;
  onVerify?(): void;
}) => {
  const { t, i18n } = useTranslation();
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  useEffect(() => {
    let live = true;
    void host
      .billingPlan?.()
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [host]);
  const remaining = billing?.current.creditsRemaining;
  const paidOffer = state === "out" && paid ? paidCreditsOffer(billing) : null;
  // The next plan alone (Basic): the free plan's pitch and Upgrade, its plan.
  const upgradeOnly = paidUpgradeOnly(paidOffer);
  const pitch = state === "out" && (!paid || upgradeOnly);
  // The way off the model this state has, first; Continue (or the picker) after.
  const lead =
    state === "credits"
      ? onSwitch != null && (
          <Button size="sm" data-action="switch-to-abacus" onClick={onSwitch}>
            {t("outcome.unavailable.switch")}
          </Button>
        )
      : state === "held"
        ? onVerify != null && (
            <Button size="sm" data-action="verify-phone" onClick={onVerify}>
              {t("outcome.verifyPhone.cta")}
            </Button>
          )
        : state === "out"
          ? paid && !upgradeOnly
            ? paidOffer != null
              ? (onTopUp != null || onNextPlan != null) && (
                  <PaidOfferButtons
                    offer={paidOffer}
                    {...(onTopUp != null && { onTopUp })}
                    {...(onNextPlan != null && { onNextPlan })}
                  />
                )
              : onTopUp != null && (
                  <Button size="sm" data-action="top-up" onClick={onTopUp}>
                    {t("creditsCard.topUpCta")}
                  </Button>
                )
            : onUpgrade != null && (
                <OfferButtons
                  billing={billing}
                  src="own_key"
                  onUpgrade={onUpgrade}
                  onSeePlans={() =>
                    void (upgradeOnly && host.openNextPlan != null
                      ? host.openNextPlan()
                      : host.openUpgrade("chat_credits"))
                  }
                />
              )
          : null;
  const next =
    onContinue != null ? (
      <Button
        size="sm"
        variant={lead ? "secondary" : "default"}
        data-action="continue-same"
        onClick={onContinue}
      >
        {t("outcome.cutoff.continue", { model: label })}
      </Button>
    ) : (
      onPickModel != null && (
        <Button
          size="sm"
          variant="secondary"
          data-action="switch-model"
          onClick={(event) => onPickModel(event.currentTarget)}
        >
          {t("outcome.unavailable.pickModel")}
        </Button>
      )
    );
  return (
    <div
      data-slot="credits-card"
      data-variant="cut-off"
      data-state={state}
      data-resolved={resolved ?? undefined}
    >
      <ChatCard icon={<CirclePause />} title={t("outcome.cutoff.title")}>
        <div className="flex flex-col gap-3 p-3 text-sm" data-slot="cut-off">
          <p>
            {t(
              streamed ? "outcome.cutoff.bodyStreamed" : "outcome.cutoff.body"
            )}
          </p>
          {resolved == null && state === "held" && (
            <p>{t("outcome.cutoff.held")}</p>
          )}
          {resolved == null && state === "out" && paid && (
            <p>{t("outcome.wall.paidTitle")}</p>
          )}
          {resolved == null && paidOffer?.inMobileApp === true && (
            <PaidOfferDetails offer={paidOffer} />
          )}
          {resolved == null && pitch && (
            <>
              {!paid && <p>{t("outcome.unavailable.creditsOut")}</p>}
              <OfferPitch billing={billing} />
            </>
          )}
        </div>
        {resolved != null ? (
          <p
            className="text-muted-foreground flex items-center gap-1.5 p-3 text-xs"
            data-slot="cut-off-resolved"
          >
            <Check aria-hidden className="text-primary size-3.5 shrink-0" />
            {t(RESOLVED_KEY[resolved], { model: label })}
          </p>
        ) : (
          (lead || next) && (
            <div className="flex flex-col gap-3 p-3">
              {lead}
              {next}
              {state === "credits" && !paid && remaining != null && (
                <p
                  className="text-muted-foreground text-xs"
                  data-slot="credits-left"
                >
                  {t("outcome.unavailable.creditsLeft", {
                    credits: new Intl.NumberFormat(i18n.language).format(
                      Math.max(0, Math.round(remaining))
                    ),
                  })}
                </p>
              )}
            </div>
          )
        )}
      </ChatCard>
    </div>
  );
};
