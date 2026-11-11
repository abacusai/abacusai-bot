import type { BillingPlan } from "@abacus-ai/contract/billing-plan";
import type { ModelAvailability } from "@abacus-ai/contract/models";
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { GALLERY_BILLING } from "#renderer/components/credits-card/threshold-gallery";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Dialog, DialogContent } from "#renderer/ui/dialog";

import { DialogBody } from "./upgrade-dialog";

export const UPGRADE_DIALOG_GALLERY_VARIANTS = ["task", "plain"] as const;
type Variant = (typeof UPGRADE_DIALOG_GALLERY_VARIANTS)[number];

/** The plan the gallery reads: the free plan's offer, its top model by id. */
const BILLING: BillingPlan = {
  ...GALLERY_BILLING,
  topModels: [{ id: "claude-opus-5-5", name: "Claude Opus 5.5" }],
};

/** The free account's catalog: the plan's top model locked behind the upgrade. */
const CATALOG: ModelAvailability[] = [
  {
    id: "abacus/claude-opus-5-5",
    label: "Claude Opus 5.5",
    provider: "abacus",
    tier: "strong",
    configured: false,
    access: "locked",
  },
];

/**
 * The credit wall's dialog for a free account, over a seeded plan and
 * catalog: `task` names the chat's task and the top model, `plain` is a chat
 * with none. Every button closes it.
 */
export const UpgradeDialogGallery = ({ variant }: { variant: Variant }) => {
  const { transport } = useAppContext();
  const queryClient = useQueryClient();
  const [seeded] = useState(() => {
    queryClient.setQueryData(
      transport.orpc.account.billingPlan.queryKey({ input: {} }),
      BILLING
    );
    queryClient.setQueryData(
      transport.orpc.models.list.queryKey({ input: {} }),
      CATALOG
    );
    return true;
  });
  const [open, setOpen] = useState(true);
  const close = () => setOpen(false);
  return (
    <Dialog open={seeded && open} onOpenChange={(next) => !next && close()}>
      <DialogContent
        showCloseButton={false}
        data-slot="upgrade-dialog"
        data-kind="credits"
        className="gap-5 p-7 pb-5 text-sm sm:max-w-[440px] [&>*]:min-w-0"
      >
        <DialogBody
          request={{
            kind: "credits",
            key: `gallery:${variant}`,
            threadId: "gallery",
            pendingText: "still cut off, fix the last row",
            ...(variant === "task" && { task: "Invoice app" }),
            resume: () => Promise.resolve(),
          }}
          from={null}
          onDone={close}
        />
      </DialogContent>
    </Dialog>
  );
};
