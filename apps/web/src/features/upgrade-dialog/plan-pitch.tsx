import {
  type BillingPlan,
  PITCH_LINES,
  type PitchLine,
  planPitch,
  type wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { Check } from "lucide-react";
import { useTranslation } from "react-i18next";

import { cn } from "#renderer/lib/cn";
import { upgradePitch, type UpgradePitch } from "#renderer/lib/credits";
import { useAccount } from "#renderer/lib/use-account";

/**
 * The plan's whole pitch, led by what the person's side gains (upgradePitch),
 * then `lead` first when a moment calls for one: the models for an own key's
 * offer, the connectors for the connectors', apps after a site was built.
 */
export const pitchOrder = (
  pitch: UpgradePitch | null,
  lead: PitchLine | null
): readonly PitchLine[] => {
  const order: readonly PitchLine[] =
    pitch === "sessions"
      ? ["models", "apps", "media", "credits", "agents", "connectors"]
      : pitch === "bots"
        ? ["credits", "agents", "connectors", "models", "apps", "media"]
        : PITCH_LINES;
  return lead == null
    ? order
    : [lead, ...order.filter((line) => line !== lead)];
};

/**
 * Every line of the plan's pitch, read from billing_plan: the one list the
 * upgrade dialog and every card that pitches the plan show, so no surface
 * names a shorter one. Nothing until the plan is read: never half a pitch.
 * `sameForEveryone` keeps the plan's own order instead of leading with the
 * person's side.
 */
export const PlanPitchList = ({
  billing,
  lead = null,
  sameForEveryone = false,
  className,
}: {
  billing: BillingPlan | null;
  lead?: PitchLine | null;
  sameForEveryone?: boolean;
  className?: string;
}) => {
  const { t, i18n } = useTranslation();
  const { data: account } = useAccount();
  if (billing == null) return null;
  const lines = planPitch(
    t,
    billing,
    i18n.language,
    pitchOrder(sameForEveryone ? null : upgradePitch(account), lead)
  );
  if (lines.length === 0) return null;
  return (
    <ul
      className={cn("flex flex-col gap-2.5", className)}
      data-slot="upgrade-pitch"
    >
      {lines.map((line) => (
        <li key={line} className="flex gap-2.5 text-sm/5">
          <Check
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400"
            strokeWidth={2.4}
          />
          <span>{line}</span>
        </li>
      ))}
    </ul>
  );
};

/** The Upgrade button's words: the plan by name when it is read. */
export const upgradeCtaLabel = (
  t: (key: string, values?: Record<string, string>) => string,
  offer: ReturnType<typeof wallOffer>
): string =>
  offer != null
    ? t("outcome.wall.upgradeCta", { plan: offer.planName })
    : t("creditsCard.cta");
