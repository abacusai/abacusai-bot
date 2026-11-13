import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import { milestoneOffer } from "@abacus-ai/contract/credit-thresholds";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { CreditThresholdCard } from "#renderer/components/credits-card/threshold";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Dialog, DialogContent } from "#renderer/ui/dialog";

import { DialogBody } from "./upgrade-dialog";

/** A Basic payer's plan as billing_plan reads it today: Pro and Max above, Pro's features verbatim. */
const PRO_FEATURES = [
  "Everything in Basic",
  "Unrestricted Abacus AI Agent: no limit on tasks while you have credits",
  "30,000 credits a month",
  "The coding agent and CLI",
  "SuperComputer: an always-on computer",
];
const CODER_BILLING: BillingPlan = {
  current: {
    plan: "basic",
    planName: "Basic",
    creditsRemaining: null,
    creditsGranted: 14000,
    freeTierExpiresAt: null,
  },
  plans: [
    {
      plan: "basic",
      planName: "Basic",
      priceText: "",
      priceCents: 1000,
      features: [],
      creditsPerMonth: 20000,
      current: true,
    },
    {
      plan: "pro",
      planName: "Pro",
      priceText: "",
      priceCents: 2000,
      features: PRO_FEATURES,
      creditsPerMonth: 30000,
      current: false,
    },
    {
      plan: "max",
      planName: "Max",
      priceText: "",
      priceCents: 10000,
      features: [],
      creditsPerMonth: 120000,
      current: false,
    },
  ],
  upgrades: [
    {
      plan: "pro",
      planName: "Pro",
      priceText: "$20/mo",
      firstMonthPriceCents: 2000,
      priceCents: 2000,
      percentOff: 0,
      features: PRO_FEATURES,
      url: "https://example.com/admin/profile?upgradeTo=pro",
    },
    {
      plan: "max",
      planName: "Max",
      priceText: "$100/mo",
      firstMonthPriceCents: 10000,
      priceCents: 10000,
      percentOff: 0,
      features: [],
      url: "https://example.com/admin/profile?upgradeTo=max",
    },
  ],
  topUpUrl: null,
  upgradeInMobileApp: false,
};

export const CODER_GALLERY_FIXTURES = [
  "coder-80",
  "coder-95",
  "coder-wall",
] as const;

/** A Basic payer who codes: the 80% and 95% cards and the wall, pitching Pro. */
export const CoderGallery = ({ fixture }: { fixture: string }) => {
  const { transport } = useAppContext();
  const queryClient = useQueryClient();
  const [seeded] = useState(() => {
    queryClient.setQueryData(
      transport.orpc.account.billingPlan.queryKey({ input: {} }),
      CODER_BILLING
    );
    queryClient.setQueryData(
      transport.orpc.models.list.queryKey({ input: {} }),
      []
    );
    return true;
  });
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  if (!open || !seeded) return null;
  if (fixture.endsWith("wall"))
    return (
      <Dialog open onOpenChange={(next) => !next && close()}>
        <DialogContent
          showCloseButton={false}
          data-slot="upgrade-dialog"
          data-kind="credits"
          className="gap-5 p-7 pb-5 text-sm sm:max-w-[440px] [&>*]:min-w-0"
        >
          <DialogBody
            request={{
              kind: "credits",
              key: `gallery:${fixture}`,
              threadId: "gallery",
              pendingText: "add Stripe checkout to the invoice page",
              task: "Invoice app",
              resume: () => Promise.resolve(),
            }}
            from={null}
            onDone={close}
            paidUpgrade
            coder
          />
        </DialogContent>
      </Dialog>
    );
  const threshold = fixture.endsWith("95") ? 95 : 80;
  const total = 14000;
  const used = Math.round(total * (threshold === 95 ? 0.96 : 0.82));
  return (
    <CreditThresholdCard
      threshold={threshold}
      used={used}
      total={total}
      estimate={{ count: threshold === 95 ? 1 : 4, kind: "builds" }}
      billing={CODER_BILLING}
      offer={milestoneOffer("paid", CODER_BILLING)}
      project="Invoice app"
      coder
      onUpgrade={close}
      onNextPlan={close}
      onContinue={close}
    />
  );
};
