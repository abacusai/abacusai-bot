/**
 * The account signed in, but the platform will not serve it until it pays
 * (its payment gate answers 402). One screen per reason, never a silent
 * sign-out: the plan, Abacus AI Agent on the web, Try again once paid, or
 * Sign out (the profile menu's sign-out: back to the first sign-in screen,
 * where another account signs in by the user's own click).
 */
import {
  type BillingPlan,
  planPitch,
  planPrice,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import type { AbacusPaymentRequired } from "@abacus-ai/contract/contracts";
import { abacusAgentPromptUrl } from "@abacus-ai/contract/toolsets";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Bot, Check, Loader2 } from "lucide-react";
import { useEffect, useEffectEvent, useState, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { signOutAbacus } from "#platform/sign-out";
import { platformSystem } from "#renderer/lib/platform-system";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

/** Where a subscriber whose payment did not confirm reports it instead of paying twice. */
const REPORT_ISSUE_URL =
  "https://github.com/abacusai/abacusai-bot/issues/new?template=bug_report.yml";

/** How often the account is asked again while checkout is open. */
const CHECKOUT_POLL_MS = 5_000;
/** The checkout link lives 30 minutes; the watch stops after it. */
const CHECKOUT_POLL_LIMIT_MS = 30 * 60 * 1000;

/** The payment gate's verdict for this window, or null. */
export const usePaymentRequired = (enabled = true) => {
  const { transport } = useAppContext();
  return useQuery({
    ...transport.orpc.account.payment.queryOptions({ input: {} }),
    enabled,
  });
};

const COPY = {
  unconfirmed: {
    title: "paymentRequired.unconfirmedTitle",
    body: "paymentRequired.unconfirmedBody",
    cta: "paymentRequired.upgrade",
  },
  trial_ended: {
    title: "paymentRequired.trialEndedTitle",
    body: "paymentRequired.trialEndedBody",
    cta: "paymentRequired.upgrade",
  },
  lapsed: {
    title: "paymentRequired.lapsedTitle",
    body: "paymentRequired.lapsedBody",
    cta: "paymentRequired.renew",
  },
} as const;

/** A server that sends no reason gets the plan picker's words. */
const paymentCopy = (payment: AbacusPaymentRequired | null) =>
  COPY[payment?.reason ?? "unconfirmed"];

export const PaymentRequiredPanel = ({
  payment,
  title,
  onSignedIn,
  onSignedOut,
  dismiss,
}: {
  payment: AbacusPaymentRequired | null;
  /** The heading, in the surface's own element (a dialog title, a step heading). */
  title: (text: string) => ReactNode;
  /** The account paid and is signed in. */
  onSignedIn?: () => void | Promise<void>;
  /** After Sign out let the account go: the surface returns to its sign-in screen. */
  onSignedOut?: () => void | Promise<void>;
  /** Not now, where the app still works without this account. */
  dismiss?: () => void;
}) => {
  const { t, i18n } = useTranslation();
  const context = useAppContext();
  const { transport } = context;
  const queryClient = useQueryClient();
  const copy = paymentCopy(payment);
  const reportText = t("paymentRequired.reportIssue");
  const lapsed = payment?.reason === "lapsed";
  const [billing, setBilling] = useState<BillingPlan | null>(null);
  const [checkoutAt, setCheckoutAt] = useState<number | null>(null);
  const [checking, setChecking] = useState(false);
  const [still, setStill] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (lapsed) return;
    let live = true;
    void transport.client.account
      .billingPlan({})
      .then((plan) => {
        if (live) setBilling(plan);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [transport, lapsed]);

  const recheck = async (asked: boolean) => {
    if (asked) setChecking(true);
    const next = await transport.client.account
      .payment({ refresh: true })
      .catch(() => payment);
    if (asked) setChecking(false);
    if (next == null) {
      await queryClient.invalidateQueries();
      await onSignedIn?.();
      return;
    }
    queryClient.setQueryData(
      transport.orpc.account.payment.queryKey({ input: {} }),
      next
    );
    if (asked) setStill(true);
  };
  const poll = useEffectEvent(() => void recheck(false));

  // Checkout runs in the browser: the app goes on the moment it lands.
  useEffect(() => {
    if (checkoutAt == null) return;
    const timer = setInterval(() => {
      if (Date.now() - checkoutAt > CHECKOUT_POLL_LIMIT_MS) setCheckoutAt(null);
      else poll();
    }, CHECKOUT_POLL_MS);
    const onFocus = () => poll();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
    };
  }, [checkoutAt]);

  const offer = lapsed ? null : wallOffer(billing);
  return (
    <div
      data-slot="payment-required"
      data-reason={payment?.reason ?? "unknown"}
      className="flex w-full max-w-[440px] flex-col gap-5 text-sm [&>*]:min-w-0"
    >
      <div className="flex flex-col items-center gap-3 text-center">
        <span
          aria-hidden
          className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
        >
          <Bot className="size-6" />
        </span>
        {title(t(copy.title))}
        <p className="text-muted-foreground text-sm/[21px]">{t(copy.body)}</p>
        {copy === COPY.unconfirmed && (
          <p
            className="text-muted-foreground text-xs"
            data-slot="payment-report"
          >
            {/* Split on the link text so each locale keeps its own word order. */}
            {t("paymentRequired.alreadySubscribed", { link: reportText })
              .split(reportText)
              .flatMap((part, index) =>
                index === 0
                  ? [part]
                  : [
                      <Button
                        key="report"
                        variant="link"
                        className="text-muted-foreground h-auto p-0 text-xs underline"
                        onClick={() =>
                          void platformSystem(transport.client).openExternal({
                            url: REPORT_ISSUE_URL,
                          })
                        }
                      >
                        {reportText}
                      </Button>,
                      part,
                    ]
              )}
          </p>
        )}
      </div>
      {offer != null && (
        <div className="flex flex-col gap-2" data-slot="payment-offer">
          <p className="font-medium">
            {t("outcome.wall.offer", {
              plan: offer.planName,
              price: planPrice(t, offer, i18n.language),
            })}
          </p>
          <ul className="flex flex-col gap-1.5">
            {planPitch(t, billing, i18n.language).map((feature) => (
              <li key={feature} className="flex gap-2 text-sm/5">
                <Check
                  aria-hidden
                  className="mt-0.5 size-4 shrink-0 text-violet-600 dark:text-violet-400"
                  strokeWidth={2.4}
                />
                <span>{feature}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      {checkoutAt != null && (
        <p className="text-muted-foreground text-center text-[13px]">
          {t("paymentRequired.waiting")}
        </p>
      )}
      {still && !checking && (
        <p role="status" className="text-center text-[13px]">
          {t("paymentRequired.stillBlocked")}
        </p>
      )}
      <div className="flex flex-col gap-1.5 pt-1">
        <Button
          className="h-11 text-sm font-semibold"
          data-action="upgrade"
          onClick={() => {
            // Called inside the click: the web build opens its tab here.
            void openUpgrade(transport.client);
            setCheckoutAt(Date.now());
          }}
        >
          {t(copy.cta)}
        </Button>
        <Button
          variant="ghost"
          className="h-10 text-sm"
          data-action="try-again"
          disabled={checking}
          onClick={() => void recheck(true)}
        >
          {checking && <Loader2 aria-hidden className="animate-spin" />}
          {t(
            checking ? "paymentRequired.checking" : "paymentRequired.tryAgain"
          )}
        </Button>
        <Button
          variant="link"
          className="text-muted-foreground h-9 text-[13px]"
          data-action="web-agent"
          onClick={() =>
            void platformSystem(transport.client).openExternal({
              url: abacusAgentPromptUrl(),
            })
          }
        >
          {t("paymentRequired.webAgent")}
        </Button>
        <div className="flex flex-wrap justify-center gap-x-1">
          <Button
            variant="ghost"
            className="text-muted-foreground h-9 text-[13px]"
            data-action="sign-out"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              // The sign-out also drops a sign-in held here for payment.
              void signOutAbacus(context, true)
                .then(async () => {
                  await queryClient.invalidateQueries();
                  await onSignedOut?.();
                })
                .catch(() => {})
                .finally(() => setBusy(false));
            }}
          >
            {t("userMenu.signOut")}
          </Button>
          {dismiss != null && (
            <Button
              variant="ghost"
              className="text-muted-foreground h-9 text-[13px]"
              data-action="not-now"
              onClick={dismiss}
            >
              {t("upgradeDialog.notNow")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

/**
 * The shell's screen for a signed-in account that must pay. It cannot be
 * waved away unless another provider can still run the app.
 */
export const PaymentRequiredDialog = () => {
  const { transport } = useAppContext();
  const payment = usePaymentRequired();
  const models = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: payment.data != null,
  });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const verdict =
    payment.data == null ? null : (payment.data.reason ?? "unknown");
  const otherProvider = (models.data ?? []).some(
    (model) => model.configured && model.provider !== "abacus"
  );
  const open = verdict != null && dismissed !== verdict;
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && otherProvider) setDismissed(verdict);
      }}
    >
      {open && (
        <DialogContent
          showCloseButton={false}
          data-slot="payment-required-dialog"
          className="items-center p-7 pb-5 sm:max-w-[440px]"
        >
          <PaymentRequiredPanel
            payment={payment.data ?? null}
            title={(text) => (
              <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
                {text}
              </DialogTitle>
            )}
            {...(otherProvider ? { dismiss: () => setDismissed(verdict) } : {})}
          />
        </DialogContent>
      )}
    </Dialog>
  );
};
