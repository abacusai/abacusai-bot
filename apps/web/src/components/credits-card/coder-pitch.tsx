import {
  type BillingPlan,
  creditsTimes,
  formatUsd,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

/**
 * A Basic payer who codes, near or at the end of the month's credits: the
 * next plan (Pro) pitched by what it changes for code: its coding router,
 * its credits against Basic's, then the rest of its list.
 */
export const coderPitch = (
  t: (key: string, values?: Record<string, string | number>) => string,
  billing: BillingPlan | null,
  locale: string
): string[] => {
  const offer = wallOffer(billing);
  if (offer == null) return [];
  const next = billing?.plans.find((plan) => plan.plan === offer.plan);
  const current = billing?.plans.find((plan) => plan.current);
  const number = (value: number) => new Intl.NumberFormat(locale).format(value);
  const ratio = creditsTimes(
    next?.creditsPerMonth,
    current?.creditsPerMonth,
    locale
  );
  return [
    t("coderPitch.router"),
    next != null
      ? t(
          ratio != null
            ? "outcome.pitch.creditsVsPlan"
            : "outcome.pitch.creditsOnly",
          {
            credits: number(next.creditsPerMonth),
            times: ratio ?? "",
            plan: current?.planName ?? "",
          }
        )
      : null,
    t("coderPitch.codingAgent"),
    t("coderPitch.agent"),
    t("coderPitch.computer"),
    t("coderPitch.everything", { plan: current?.planName ?? "" }),
  ].filter((line): line is string => line != null);
};

export const CoderPitchList = ({
  billing,
}: {
  billing: BillingPlan | null;
}) => {
  const { t, i18n } = useTranslation();
  return (
    <ul className="flex flex-col gap-2" data-slot="coder-pitch">
      {coderPitch(t, billing, i18n.language).map((line, index) => (
        <li key={line} className="flex gap-2 text-sm/5">
          <Check
            aria-hidden
            className="text-primary mt-0.5 size-4 shrink-0"
            strokeWidth={2.4}
          />
          <span className={index === 0 ? "font-medium" : undefined}>
            {line}
          </span>
        </li>
      ))}
    </ul>
  );
};

/** "Move to Pro · $20/month". */
export const coderCta = (
  t: (key: string, values?: Record<string, string>) => string,
  billing: BillingPlan | null,
  locale: string
): string => {
  const offer = wallOffer(billing);
  return offer?.priceCents != null
    ? t("coderPitch.cta", {
        plan: offer.planName,
        price: formatUsd(offer.priceCents, locale),
      })
    : t("outcome.wall.upgradeCta", { plan: offer?.planName ?? "" });
};
