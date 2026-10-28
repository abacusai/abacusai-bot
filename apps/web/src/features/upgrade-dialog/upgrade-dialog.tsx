import {
  paidCreditsOffer,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import type { AbacusAccountInfo } from "@abacus-ai/contract/contracts";
import { providerDisplayName } from "@abacus-ai/contract/settings";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Bot,
  Calendar,
  Clock,
  Folder,
  Loader2,
  Mail,
  MessageSquare,
} from "lucide-react";
import { useEffect, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { PaidOfferDetails } from "#renderer/components/credits-card/paid-offer";
import { creditsTier } from "#renderer/lib/credits";
import {
  ownKeyHeadlineKey,
  ownKeyResumeModel,
} from "#renderer/lib/own-key-unavailable";
import {
  checkPlanNow,
  onPlanActive,
  openNextPlan,
  openTopUp,
  openUpgrade,
  payingAccount,
  watchForCredits,
  watchForPlan,
} from "#renderer/lib/upgrade";
import {
  closeUpgradeDialog,
  useUpgradeDialogRequest,
  type UpgradeDialogRequest,
} from "#renderer/lib/upgrade-dialog";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

import { PlanPitchList, upgradeCtaLabel } from "./plan-pitch";

/** A free account whose Abacus credits are used up: the only one asked. */
export const spentFreeAccount = (
  account: AbacusAccountInfo | null | undefined
): boolean =>
  creditsTier(account) === "free" &&
  account?.credits_granted != null &&
  account.credits_used != null &&
  account.credits_used >= account.credits_granted;

/** Who a request is for: own-key and plan ask any free account, spent or not. */
const askedAccount = (
  request: UpgradeDialogRequest,
  account: AbacusAccountInfo | null | undefined
): boolean =>
  request.kind === "own-key" || request.kind === "plan"
    ? creditsTier(account) === "free"
    : spentFreeAccount(account);

const Tile = ({ children }: { children: ReactNode }) => (
  <span className="bg-muted text-foreground flex size-10 items-center justify-center rounded-[11px]">
    {children}
  </span>
);

/**
 * A paid plan out of credits: its top-up and its next plan up (price and
 * features from billing_plan), or the mobile app where a store-billed plan
 * buys both. Either waits for the credits or the plan, then sends the
 * waiting message.
 */
const PaidBody = ({
  request,
  onDone,
}: {
  request: UpgradeDialogRequest;
  onDone: (dismissed: boolean) => void;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    staleTime: 60_000,
  });
  const [waiting, setWaiting] = useState(request.checkout === true);
  const offer = paidCreditsOffer(billing ?? null);

  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    void watchForCredits(transport.client).then((fresh) => {
      if (stopped) return;
      if (fresh == null) {
        setWaiting(false);
        return;
      }
      onDone(false);
      void request.resume?.().catch(() => {});
    });
    return () => {
      stopped = true;
    };
  }, [waiting, transport, request, onDone]);

  if (waiting)
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2
          aria-hidden
          className="text-muted-foreground size-6 animate-spin"
        />
        <DialogTitle className="text-lg font-semibold">
          {t("upgradeDialog.paidWaitingTitle")}
        </DialogTitle>
        <p className="text-muted-foreground text-sm">
          {t(
            request.resume != null && request.pendingText != null
              ? "upgradeDialog.paidWaitingBody"
              : "upgradeDialog.paidWaitingBodyNoMessage"
          )}
        </p>
        <div className="flex w-full flex-col gap-1.5 pt-1">
          <Button className="h-10" onClick={checkPlanNow}>
            {t("upgradeDialog.paidCheckAgain")}
          </Button>
          <Button
            variant="ghost"
            className="h-10"
            onClick={() => onDone(false)}
          >
            {t("upgradeDialog.close")}
          </Button>
        </div>
      </div>
    );

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
        >
          <Bot className="size-6" />
        </span>
        <p className="text-muted-foreground text-xs font-medium tracking-[0.02em]">
          {t("outcome.wall.paidTitle")}
        </p>
        <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
          {t("upgradeDialog.creditsTitle")}
        </DialogTitle>
        <p className="text-muted-foreground text-sm/[21px]">
          {t(
            offer?.inMobileApp === true
              ? "upgradeDialog.paidBodyMobile"
              : request.pendingText != null
                ? "upgradeDialog.paidBody"
                : "upgradeDialog.paidBodyNoMessage"
          )}
        </p>
      </div>
      {request.pendingText != null && (
        <div className="bg-muted flex min-w-0 items-center gap-2.5 rounded-[10px] px-3 py-2.5">
          <Clock
            aria-hidden
            className="text-muted-foreground size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {t("upgradeDialog.waitingToSend", { text: request.pendingText })}
          </span>
        </div>
      )}
      {offer != null && (
        <div className="text-sm" data-slot="upgrade-paid-offer">
          <PaidOfferDetails offer={offer} />
        </div>
      )}
      <div className="flex flex-col gap-1.5 pt-1">
        {offer?.topUpUrl != null && (
          <Button
            className="h-11 text-sm font-semibold"
            data-action="top-up"
            onClick={() => {
              // Called inside the click: the web build opens its tab here.
              void openTopUp(transport.client);
              setWaiting(true);
            }}
          >
            {t("creditsCard.topUpCta")}
          </Button>
        )}
        {offer?.next != null && !offer.inMobileApp && (
          <Button
            variant={offer.topUpUrl != null ? "secondary" : "default"}
            className="h-11 text-sm font-semibold"
            data-action="next-plan"
            onClick={() => {
              void openNextPlan(transport.client);
              setWaiting(true);
            }}
          >
            {t("outcome.wall.upgradeCta", { plan: offer.next.planName })}
          </Button>
        )}
        <Button
          variant="ghost"
          className="text-muted-foreground h-10 text-sm"
          onClick={() => onDone(true)}
        >
          {t("upgradeDialog.notNow")}
        </Button>
      </div>
    </>
  );
};

const DialogBody = ({
  request,
  onDone,
}: {
  request: UpgradeDialogRequest;
  /** `dismissed` when the person said no; not when they paid or are paying. */
  onDone: (dismissed: boolean) => void;
}) => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    staleTime: 60_000,
  });
  // Asked for at checkout (a card's Upgrade): straight to waiting for the plan.
  const [waiting, setWaiting] = useState(request.checkout === true);
  const connectors = request.kind === "connectors";
  const ownKey = request.kind === "own-key";
  const plan = request.kind === "plan";
  const offer = wallOffer(billing ?? null);

  // Checkout runs in the browser: once the plan is active (lib/upgrade.ts
  // watches for it), send the waiting message and close.
  useEffect(() => {
    if (!waiting) return;
    let stopped = false;
    void watchForPlan(transport.client).then(async (paid) => {
      if (stopped) return;
      if (paid == null) {
        setWaiting(false);
        return;
      }
      onDone(false);
      if (request.kind !== "own-key") {
        void request.resume?.().catch(() => {});
        return;
      }
      // The plan's catalog, which the watch has just read afresh.
      const models = await transport.client.models.list({}).catch(() => []);
      void request.resume?.(ownKeyResumeModel(models)).catch(() => {});
    });
    return () => {
      stopped = true;
    };
  }, [waiting, transport, request, onDone]);

  if (waiting)
    return (
      <div className="flex flex-col items-center gap-3 text-center">
        <Loader2
          aria-hidden
          className="text-muted-foreground size-6 animate-spin"
        />
        <DialogTitle className="text-lg font-semibold">
          {t("upgradeDialog.waitingTitle")}
        </DialogTitle>
        <p className="text-muted-foreground text-sm">
          {t(
            request.resume != null && request.pendingText != null
              ? "upgradeDialog.waitingBody"
              : "upgradeDialog.waitingBodyNoMessage"
          )}
        </p>
        <div className="flex w-full flex-col gap-1.5 pt-1">
          <Button className="h-10" onClick={checkPlanNow}>
            {t("upgradeDialog.checkAgain")}
          </Button>
          <Button
            variant="ghost"
            className="h-10"
            onClick={() => onDone(false)}
          >
            {t("upgradeDialog.close")}
          </Button>
        </div>
      </div>
    );

  return (
    <>
      <div className="flex flex-col items-center gap-3 text-center">
        {connectors ? (
          <span aria-hidden className="flex gap-2">
            <Tile>
              <Mail className="size-5" />
            </Tile>
            <Tile>
              <Calendar className="size-5" />
            </Tile>
            <Tile>
              <MessageSquare className="size-5" />
            </Tile>
            <Tile>
              <Folder className="size-5" />
            </Tile>
            <span className="bg-primary text-primary-foreground flex size-10 items-center justify-center rounded-[11px] text-xs font-semibold">
              {t("upgradeDialog.connectorsCount")}
            </span>
          </span>
        ) : (
          <span
            aria-hidden
            className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
          >
            <Bot className="size-6" />
          </span>
        )}
        {!plan && (
          <p className="text-muted-foreground text-xs font-medium tracking-[0.02em]">
            {request.ownKey != null
              ? t(ownKeyHeadlineKey(request.ownKey.cause), {
                  provider: providerDisplayName(request.ownKey.provider),
                })
              : t(
                  connectors
                    ? "upgradeDialog.connectorsEyebrow"
                    : request.expired === true
                      ? "outcome.wall.expiredTitle"
                      : "outcome.wall.title"
                )}
          </p>
        )}
        <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
          {plan
            ? offer != null
              ? t("upgradeDialog.planTitle", { plan: offer.planName })
              : t("upgradeDialog.creditsTitle")
            : ownKey
              ? t("upgradeDialog.ownKeyTitle")
              : t(
                  connectors
                    ? "upgradeDialog.connectorsTitle"
                    : "upgradeDialog.creditsTitle"
                )}
        </DialogTitle>
        {!plan && (
          <p className="text-muted-foreground text-sm/[21px]">
            {t(
              connectors
                ? "upgradeDialog.connectorsBody"
                : ownKey
                  ? request.pendingText != null
                    ? "upgradeDialog.ownKeyBody"
                    : "upgradeDialog.ownKeyBodyNoMessage"
                  : request.pendingText != null
                    ? "upgradeDialog.creditsBody"
                    : "upgradeDialog.creditsBodyNoMessage"
            )}
          </p>
        )}
      </div>
      {request.pendingText != null && (
        <div className="bg-muted flex min-w-0 items-center gap-2.5 rounded-[10px] px-3 py-2.5">
          <Clock
            aria-hidden
            className="text-muted-foreground size-4 shrink-0"
          />
          <span className="min-w-0 flex-1 truncate text-[13px]">
            {t("upgradeDialog.waitingToSend", { text: request.pendingText })}
          </span>
        </div>
      )}
      {offer != null && (
        <div className="flex flex-col gap-1" data-slot="upgrade-price">
          <p className="flex items-baseline gap-2">
            {connectors && (
              <span className="text-muted-foreground text-sm">
                {t("upgradeDialog.startAt")}
              </span>
            )}
            <span className="text-lg font-bold tracking-[-0.01em]">
              {planPrice(t, offer, i18n.language)}
            </span>
          </p>
          <p className="text-muted-foreground text-[13px]">
            {t("upgradeDialog.planLine", { plan: offer.planName })}
          </p>
        </div>
      )}
      <PlanPitchList
        billing={billing ?? null}
        lead={ownKey ? "models" : connectors ? "connectors" : null}
      />
      <div className="flex flex-col gap-1.5 pt-1">
        <Button
          className="h-11 text-sm font-semibold"
          onClick={() => {
            // Called inside the click: the web build opens its tab here.
            void openUpgrade(transport.client);
            setWaiting(true);
          }}
        >
          {upgradeCtaLabel(t, offer)}
        </Button>
        <Button
          variant="ghost"
          className="text-muted-foreground h-10 text-sm"
          onClick={() => onDone(true)}
        >
          {t(
            connectors ? "upgradeDialog.keepChatting" : "upgradeDialog.notNow"
          )}
        </Button>
      </div>
    </>
  );
};

/**
 * The window-wide upgrade dialog. It opens for a request only when a fresh
 * account read shows a free account with its credits used up (any free
 * account, for a failure on its own key), so another provider's quota error
 * that reads like ours never sells this plan. A paid plan's credits request
 * opens only when the server offers it a top-up, a plan up or the mobile app.
 */
export const UpgradeDialogHost = () => {
  const request = useUpgradeDialogRequest();
  const { transport } = useAppContext();
  const qc = useQueryClient();
  const [confirmed, setConfirmed] = useState<{
    key: string;
    paid: boolean;
  } | null>(null);

  // A plan bought from any surface: the account and the catalog every card and
  // picker reads change at once, not on their next poll.
  useEffect(
    () =>
      onPlanActive(() => {
        void qc.invalidateQueries({
          queryKey: transport.orpc.account.abacus.key(),
        });
        void qc.invalidateQueries({
          queryKey: transport.orpc.models.list.key(),
        });
      }),
    [qc, transport]
  );

  useEffect(() => {
    if (request == null) return;
    let live = true;
    void transport.client.account
      .abacus({ refresh: true })
      .then(async (account) => {
        if (!live) return;
        if (askedAccount(request, account)) {
          setConfirmed({ key: request.key, paid: false });
          return;
        }
        const paid =
          request.kind === "credits" &&
          payingAccount(account) &&
          paidCreditsOffer(
            await transport.client.account.billingPlan({}).catch(() => null)
          ) != null;
        if (!live) return;
        if (paid) setConfirmed({ key: request.key, paid: true });
        else closeUpgradeDialog();
      })
      .catch(() => {
        if (live) closeUpgradeDialog();
      });
    return () => {
      live = false;
    };
  }, [request, transport]);

  const open = request != null && confirmed?.key === request.key;
  const done = (dismissed: boolean) => {
    setConfirmed(null);
    closeUpgradeDialog(dismissed);
  };
  return (
    <Dialog open={open} onOpenChange={(next) => !next && done(true)}>
      {request != null && open && (
        <DialogContent
          showCloseButton={false}
          data-slot="upgrade-dialog"
          data-kind={request.kind}
          className="gap-5 p-7 pb-5 text-sm sm:max-w-[440px] [&>*]:min-w-0"
        >
          {confirmed?.paid === true ? (
            <PaidBody key={request.key} request={request} onDone={done} />
          ) : (
            <DialogBody key={request.key} request={request} onDone={done} />
          )}
        </DialogContent>
      )}
    </Dialog>
  );
};
