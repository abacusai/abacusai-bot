import {
  type BillingPlan,
  formatUsd,
  planPitch,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { AlertTriangle, Check, Lock } from "lucide-react";
import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard } from "#renderer/components/form-kit/page";
import { Button } from "#renderer/ui/button";

import type { CreditActions } from "./index";

/** Why the picked model cannot serve the turn, as the agent named it. */
export type ModelUnavailableKind = "retired" | "down" | "plan";

/**
 * The one card for a model the user picked that cannot serve the turn: what
 * failed and why, then RouteLLM - Open while Abacus credits are left (the
 * user's choice, never a silent switch) or the plan once they are used up.
 * Prices, credits and features come from billing_plan.
 */
export const ModelUnavailableCard = ({
  host,
  kind,
  label,
  creditsOut,
  onSwitch,
  onPickModel,
  onUpgrade,
}: {
  host: CreditActions;
  kind: ModelUnavailableKind;
  label: string;
  creditsOut: boolean;
  /** Re-sends the kept message on RouteLLM - Open. */
  onSwitch?(): void;
  /** Opens the model picker of the chat this card is in. */
  onPickModel?(from: HTMLElement): void;
  /** The upgrade dialog that resumes the turn. */
  onUpgrade?(): void;
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
  const offer = wallOffer(billing);
  const remaining = billing?.current.creditsRemaining;
  const upgrade = () =>
    onUpgrade != null ? onUpgrade() : void host.openUpgrade();
  const plan = kind === "plan" && !creditsOut;
  const Icon = kind === "plan" ? Lock : AlertTriangle;
  const first = offer?.firstMonthPriceCents;
  const monthly = offer?.priceCents;
  const upgradeLabel =
    first != null && monthly != null && first < monthly
      ? t("outcome.unavailable.upgradeIntro", {
          price: formatUsd(first, i18n.language),
        })
      : monthly != null
        ? t("outcome.unavailable.upgradeMonthly", {
            price: formatUsd(monthly, i18n.language),
          })
        : offer != null
          ? t("outcome.wall.upgradeCta", { plan: offer.planName })
          : t("creditsCard.cta");
  return (
    <div data-slot="credits-card" data-variant="model-unavailable">
      <GroupCard>
        <h2
          className="phone:px-4 phone:text-[15px] flex items-center gap-2 px-3 py-3 text-[13px] font-semibold"
          data-kind={kind}
        >
          <Icon
            aria-hidden
            className="size-4 shrink-0 text-[var(--chat-status-attention)]"
          />
          {t(`outcome.unavailable.title.${kind}`, { model: label })}
        </h2>
        <div
          className="flex flex-col gap-3 p-3 text-sm"
          data-slot="model-unavailable"
        >
          {creditsOut ? (
            <>
              <p>{t("outcome.unavailable.creditsOut")}</p>
              {offer != null && (
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
              )}
            </>
          ) : plan ? (
            <p>
              {offer != null
                ? t("outcome.unavailable.planBody", { plan: offer.planName })
                : t("outcome.unavailable.planBodyAny")}
            </p>
          ) : (
            <p>
              {t(`outcome.unavailable.why.${kind}`)}{" "}
              {t("outcome.unavailable.kept")}
            </p>
          )}
        </div>
        <div className="flex flex-col gap-3 p-3">
          {creditsOut ? (
            <>
              <Button size="sm" data-action="upgrade" onClick={upgrade}>
                {upgradeLabel}
              </Button>
              <Button
                size="sm"
                variant="secondary"
                data-action="see-plans"
                onClick={() => void host.openUpgrade()}
              >
                {t("outcome.unavailable.seePlans")}
              </Button>
            </>
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
                <Button
                  variant="link"
                  size="sm"
                  data-action="upgrade"
                  className="self-start px-0"
                  onClick={upgrade}
                >
                  {offer != null
                    ? t("outcome.wall.upgradeCta", { plan: offer.planName })
                    : t("creditsCard.cta")}
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
      </GroupCard>
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
 * they are held, the plan (its dialog, never a price here) or a top-up once
 * they are used up; Continue goes on the same model until the session's
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
  const offer = wallOffer(billing);
  const remaining = billing?.current.creditsRemaining;
  const pitch = state === "out" && !paid;
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
          ? paid
            ? onTopUp != null && (
                <Button size="sm" data-action="top-up" onClick={onTopUp}>
                  {t("creditsCard.topUpCta")}
                </Button>
              )
            : onUpgrade != null && (
                <Button size="sm" data-action="upgrade" onClick={onUpgrade}>
                  {offer != null
                    ? t("outcome.wall.upgradeCta", { plan: offer.planName })
                    : t("creditsCard.cta")}
                </Button>
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
      <GroupCard>
        <h2 className="phone:px-4 phone:text-[15px] flex items-center gap-2 px-3 py-3 text-[13px] font-semibold">
          <AlertTriangle
            aria-hidden
            className="size-4 shrink-0 text-[var(--chat-status-attention)]"
          />
          {t("outcome.cutoff.title")}
        </h2>
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
          {resolved == null && pitch && (
            <>
              <p>{t("outcome.unavailable.creditsOut")}</p>
              {offer != null && (
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
              )}
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
      </GroupCard>
    </div>
  );
};
