import type {
  BillingPlan,
  BillingPlanTier,
} from "@abacus-ai/contract/billing-plan";
import {
  type CreditThreshold,
  milestoneOffer,
} from "@abacus-ai/contract/credit-thresholds";
import { useState } from "react";

import { CreditThresholdCard } from "./threshold";

/**
 * The dev gallery's plan: a free account offered Basic with a first-month
 * price, its features worded as billing_plan words them.
 */
const GALLERY_BILLING: BillingPlan = {
  current: {
    planName: "Free",
    creditsRemaining: null,
    creditsGranted: 2000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [],
      creditsPerMonth: 20000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      firstMonthPriceCents: 700,
      priceCents: 1000,
      features: [
        "Top models including GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.1 and Gemini 4 Argon",
        "Image and video generation",
      ],
      url: null,
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

const PAID_TIER = (
  plan: string,
  planName: string,
  cents: number
): BillingPlanTier => ({
  plan,
  planName,
  priceText: "",

  priceCents: cents,
  features: [
    "Top models including GPT-6.1 Sol, Claude Opus 5.5, Claude Fable 5.1 and Gemini 4 Argon",
    "Image and video generation",
  ],
});

/** A paid plan's read: Basic offers its next plan alone, Pro its top-up and next plan. */
const galleryPaidBilling = (plan: "basic" | "pro"): BillingPlan => {
  const [current, next] =
    plan === "basic"
      ? [PAID_TIER("basic", "Basic", 1000), PAID_TIER("pro", "Pro", 2000)]
      : [PAID_TIER("pro", "Pro", 2000), PAID_TIER("max", "Max", 20000)];
  return {
    current: {
      plan,
      planName: current.planName,
      creditsRemaining: null,
      creditsGranted: 20000,
      freeTierExpiresAt: null,
    },
    plans: [
      { ...current, creditsPerMonth: 20000, current: true },
      { ...next, creditsPerMonth: 50000, current: false },
    ],
    upgrades: [{ ...next, url: "https://example.com/upgrade" }],
    topUpUrl: plan === "basic" ? null : "https://example.com/top-up",
    upgradeInMobileApp: false,
  };
};

/** The paid cards' variants: the plan, and a chat on a top model or not. */
export const PAID_CREDIT_GALLERY_VARIANTS = [
  "basic-top-model",
  "pro-top-model",
  "basic-router",
] as const;
export type PaidCreditGalleryVariant =
  (typeof PAID_CREDIT_GALLERY_VARIANTS)[number];

/** Both milestone cards for the gallery and its screenshots; either button closes it. */
export const CreditThresholdGallery = ({
  threshold,
  paid,
}: {
  threshold: CreditThreshold;
  /** Absent: the free plan's card. */
  paid?: PaidCreditGalleryVariant;
}) => {
  const [open, setOpen] = useState(true);
  const billing =
    paid != null
      ? galleryPaidBilling(paid.startsWith("pro") ? "pro" : "basic")
      : GALLERY_BILLING;
  const total = paid != null ? 20000 : 2000;
  const used = Math.round(total * (threshold === 80 ? 0.82 : 0.52));
  const close = () => setOpen(false);
  return open ? (
    <CreditThresholdCard
      threshold={threshold}
      used={used}
      total={total}
      estimate={{ count: threshold === 80 ? 4 : 12, kind: "builds" }}
      billing={billing}
      {...(paid != null
        ? {
            offer: milestoneOffer("paid", billing),
            project: "Shop landing page",
            onNextPlan: close,
            onTopUp: close,
          }
        : {})}
      {...(paid?.endsWith("top-model")
        ? {
            cheaper: {
              model: "RouteLLM",
              // Stays preparing, so the gallery shows the busy button.
              onSwitch: () => new Promise<void>(() => undefined),
            },
          }
        : {})}
      onUpgrade={close}
      onContinue={close}
    />
  ) : null;
};
