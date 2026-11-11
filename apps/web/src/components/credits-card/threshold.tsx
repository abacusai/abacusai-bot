import {
  type BillingPlan,
  formatUsd,
  paidCreditsOffer,
  paidUpgradeOnly,
  planPitch,
  planTopModelIds,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import { cheaperModelOffer } from "@abacus-ai/contract/cheaper-model";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  creditAccountKey,
  creditMilestonePlan,
  type CreditTaskKind,
  type CreditThreshold,
  creditThresholdWords,
  milestoneBalance,
  markPlan,
  type MilestoneOffer,
  milestoneOffer,
  pendingThreshold,
  tasksLeft,
} from "@abacus-ai/contract/credit-thresholds";
import { resolveConfiguredModel } from "@abacus-ai/contract/models";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Gauge, Leaf } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { type Db, useCollections, useDb } from "#renderer/data/db";
import { isListedSession, isListedWorkspace } from "#renderer/data/db/filters";
import { usePrefs } from "#renderer/data/db/prefs";
import type { AppClient } from "#renderer/data/transport/types";
import { showError, showInfo } from "#renderer/lib/toast";
import { openNextPlan, openTopUp, openUpgrade } from "#renderer/lib/upgrade";
import { useUpgradeDialogRequest } from "#renderer/lib/upgrade-dialog";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "#renderer/ui/dialog";

/**
 * An account's credit milestone card (contract credit-thresholds.ts): half,
 * then four fifths, of the plan's credits used. Over the window between
 * turns; it stays until a button is picked, and Esc keeps going. The free
 * plan is offered its upgrade; a paid plan its top-up and next plan by the
 * one offer rule (paidCreditsOffer), Basic its next plan alone, pitched as
 * the free plan's upgrade is. A paid chat on a top model is also offered its
 * plan's low-cost model (cheaper-model.ts).
 */

export interface CreditThresholdCardProps {
  threshold: CreditThreshold;
  used: number;
  total: number;
  estimate: { count: number; kind: CreditTaskKind | null } | null;
  billing: BillingPlan | null;
  /** The chat the user is on, by its name: what running out would stop. */
  project?: string;
  /** Absent: the free plan's. */
  offer?: MilestoneOffer;
  /** The upgrade as the free plan has it, which Basic's next plan alone also opens. */
  onUpgrade(): void;
  /** A paid plan's next plan, beside its top-up. */
  onNextPlan?(): void;
  onTopUp?(): void;
  /** A paid chat on a top model: move it to the plan's low-cost model, by name. */
  cheaper?: { model: string; onSwitch(): void };
  onContinue(): void;
}

export const CreditThresholdCard = ({
  threshold,
  used,
  total,
  estimate,
  billing,
  project,
  offer: milestone = { plan: "free" },
  onUpgrade,
  onNextPlan,
  onTopUp,
  cheaper,
  onContinue,
}: CreditThresholdCardProps) => {
  const { t, i18n } = useTranslation();
  const locale = i18n.language;
  const number = (value: number) =>
    new Intl.NumberFormat(locale).format(Math.max(0, Math.round(value)));
  const left = Math.max(0, total - used);
  const { title, lines } = creditThresholdWords(
    t,
    locale,
    threshold,
    { left, total },
    estimate,
    project,
    milestone
  );
  const paid = milestone.plan === "paid" ? milestone.offer : null;
  const isPaid = milestone.plan === "paid";
  // Basic's next plan alone reads as the free plan's upgrade.
  const upgradeLike = !isPaid || paidUpgradeOnly(paid);
  const mobile = paid?.inMobileApp === true;
  const topUp = isPaid && !mobile && paid?.topUpUrl != null && onTopUp != null;
  const nextPlan =
    isPaid &&
    !mobile &&
    !upgradeLike &&
    paid?.next?.url != null &&
    onNextPlan != null
      ? paid.next
      : null;
  const pitched = upgradeLike || nextPlan != null;
  const offer = wallOffer(billing);
  const first = offer?.firstMonthPriceCents;
  const price = offer?.priceCents;
  const Icon = threshold === 80 ? AlertTriangle : Gauge;
  return (
    <Dialog
      open
      disablePointerDismissal
      onOpenChange={(next) => {
        if (!next) onContinue();
      }}
    >
      <DialogContent
        showCloseButton={false}
        data-slot="credit-threshold-card"
        data-threshold={threshold}
        className="gap-5 p-6 pb-5 text-sm sm:max-w-[440px] [&>*]:min-w-0"
      >
        <div className="flex flex-col items-start gap-3">
          <span
            aria-hidden
            className={
              threshold === 80
                ? "flex size-10 items-center justify-center rounded-[11px] bg-[color-mix(in_oklch,var(--chat-status-attention)_14%,transparent)] text-[var(--chat-status-attention)]"
                : "bg-primary/12 text-primary flex size-10 items-center justify-center rounded-[11px]"
            }
          >
            <Icon className="size-5" />
          </span>
          <DialogTitle className="text-lg/6 font-semibold text-balance">
            {title}
          </DialogTitle>
          <DialogDescription className="text-muted-foreground text-sm/5">
            {lines.join(" ")}
          </DialogDescription>
        </div>
        <div className="flex flex-col gap-1.5">
          <div
            role="meter"
            aria-label={t(
              isPaid
                ? "creditThreshold.paidMeterLabel"
                : "creditThreshold.meterLabel",
              { used: number(used), total: number(total) }
            )}
            aria-valuemin={0}
            aria-valuemax={total}
            aria-valuenow={Math.min(total, Math.max(0, used))}
            className="bg-muted h-2 overflow-hidden rounded-full"
          >
            <div
              className={
                threshold === 80
                  ? "h-full rounded-full bg-[var(--chat-status-attention)]"
                  : "bg-primary h-full rounded-full"
              }
              style={{
                width: `${total > 0 ? Math.min(100, (used / total) * 100) : 0}%`,
              }}
            />
          </div>
          <div className="text-muted-foreground flex justify-between text-xs tabular-nums">
            <span>{t("creditThreshold.used", { used: number(used) })}</span>
            <span>{t("creditThreshold.left", { left: number(left) })}</span>
          </div>
        </div>
        {mobile ? (
          <p
            className="text-muted-foreground text-sm/5"
            data-slot="credit-threshold-mobile"
          >
            {t("outcome.wall.paidMobile")}
          </p>
        ) : pitched ? (
          <ul
            className="flex flex-col gap-2"
            data-slot="credit-threshold-benefits"
          >
            {planPitch(t, billing, locale).map((line) => (
              <li key={line} className="flex gap-2 text-sm/5">
                <Check
                  aria-hidden
                  className="text-primary mt-0.5 size-4 shrink-0"
                  strokeWidth={2.4}
                />
                <span>{line}</span>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex flex-col gap-1.5">
          {topUp && (
            <Button
              className="h-10 text-sm font-semibold"
              data-action="top-up"
              onClick={onTopUp}
            >
              {t("creditsCard.topUpCta")}
            </Button>
          )}
          {nextPlan != null && (
            <Button
              variant={topUp ? "secondary" : "default"}
              className="h-10 text-sm font-semibold"
              data-action="next-plan"
              onClick={onNextPlan}
            >
              {t("outcome.wall.upgradeCta", { plan: nextPlan.planName })}
            </Button>
          )}
          {!mobile && upgradeLike && (
            <Button
              className="h-10 text-sm font-semibold"
              data-action="upgrade"
              onClick={onUpgrade}
            >
              {first != null && price != null && first < price
                ? t("creditThreshold.upgradeIntro", {
                    price: formatUsd(first, locale),
                  })
                : price != null
                  ? t("creditThreshold.upgradeMonthly", {
                      price: formatUsd(price, locale),
                    })
                  : t("creditThreshold.upgrade")}
            </Button>
          )}
          {isPaid && cheaper != null && (
            <Button
              variant="outline"
              className="h-auto min-h-10 py-2 text-sm font-medium whitespace-normal"
              data-action="switch-cheaper"
              onClick={cheaper.onSwitch}
            >
              <Leaf aria-hidden className="text-primary size-4 shrink-0" />
              {t("creditThreshold.switchCheaper", { model: cheaper.model })}
            </Button>
          )}
          <Button
            variant="ghost"
            className="text-muted-foreground h-10 text-sm"
            data-action="continue-free"
            onClick={onContinue}
          >
            {t(
              isPaid
                ? "creditThreshold.keepGoing"
                : "creditThreshold.continueFree"
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The card for the signed-in account's latest milestone, until it is
 * answered. Never for an unread plan or spent credits (the out-of-credits
 * card's), and it never opens over a running turn or the upgrade dialog.
 */
export const CreditThresholdHost = ({
  setChatModel,
}: {
  /** Moves one chat to a model (the sessions feature's), passed in by the shell. */
  setChatModel?(
    db: Db,
    client: AppClient,
    row: SessionRow,
    model: string,
    options: { thisChatOnly: true }
  ): Promise<void>;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const db = useDb();
  const prefs = usePrefs();
  const { data: account } = useAccount();
  const upgradeAsked = useUpgradeDialogRequest() != null;
  const collections = useCollections();
  const { data: sessions } = useLiveQuery((q) =>
    q.from({ s: collections.sessions })
  );
  const turnRunning = (sessions ?? []).some(
    (session) => session.turn?.isBusy === true
  );
  // The chat the user worked in last; not a routine run's or a bot's.
  const latest = (sessions ?? [])
    .filter(
      (session) =>
        session.routineId == null &&
        session.editorFor == null &&
        !session.botOwned &&
        session.label.trim().length > 0
    )
    .reduce<SessionRow | null>(
      (latest, session) =>
        latest == null || session.updatedAt > latest.updatedAt
          ? session
          : latest,
      null
    );
  const project = latest?.label.trim();
  const key = creditAccountKey(account);
  const mark = key != null ? prefs.creditThresholds?.[key] : undefined;
  const cards = prefs.dismissals.creditThresholdCards ?? {};
  const card = key != null ? cards[key] : undefined;
  // The plan the watch stamped on the mark, as every surface reads it.
  const plan =
    mark != null && creditMilestonePlan(account) != null
      ? markPlan(mark)
      : null;
  const balance = milestoneBalance(account);
  const total = balance?.granted ?? null;
  // The account query can trail the read that stamped the mark.
  const used =
    balance != null
      ? Math.max(balance.used, mark?.granted === total ? (mark?.used ?? 0) : 0)
      : null;
  // At the whole of the credits the out-of-credits card speaks instead.
  const owed =
    plan != null && used != null && total != null && used < total
      ? pendingThreshold(mark, card)
      : null;
  const { data: billing, isPending: billingPending } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: owed != null,
    staleTime: 60_000,
  });
  // A paid chat on a top model is offered its plan's low-cost model. The
  // chat's model as it runs: its pin, else the app's default, resolved.
  const { data: catalog } = useQuery({
    ...transport.orpc.models.list.queryOptions({ input: {} }),
    enabled: owed != null && plan === "paid",
    staleTime: 5 * 60_000,
  });
  const { data: settings } = useQuery({
    ...transport.orpc.settings.get.queryOptions({ input: {} }),
    enabled: owed != null && plan === "paid",
  });
  const workspace =
    latest != null ? collections.workspaces.get(latest.workspaceId) : undefined;
  const cheaper = cheaperModelOffer({
    plan,
    modelId:
      latest != null && catalog != null
        ? resolveConfiguredModel({
            requested: latest.model,
            defaultModel: settings?.defaultModel,
            catalog,
          })
        : null,
    listed:
      latest != null &&
      isListedSession(latest) &&
      workspace != null &&
      isListedWorkspace(workspace),
    catalog: catalog ?? [],
    planIds: planTopModelIds(billing),
  });
  // A paid plan's buttons are its offer's: the card waits for the plan read,
  // and a paid plan with nothing to offer gets no card.
  const offerKnown =
    plan !== "paid" ||
    (!billingPending && paidCreditsOffer(billing ?? null) != null);
  // Once on screen it stays until answered, whatever starts behind it.
  const visible =
    owed != null &&
    offerKnown &&
    !upgradeAsked &&
    (card?.shown === owed || !turnRunning);

  const write = (next: {
    shown: CreditThreshold;
    answered: CreditThreshold | null;
  }) =>
    void db
      .updatePrefs({
        dismissals: {
          creditThresholdCards: { ...cards, [key!]: next },
        },
      })
      .catch(() => undefined);
  const shown = useEffectEvent((threshold: CreditThreshold) => {
    if (card?.shown === threshold) return;
    console.info(`[credits] threshold card ${threshold} shown (${plan})`);
    void transport.client.system
      .funnelStep({
        step:
          plan === "paid"
            ? `credit_card_paid_${threshold}_shown`
            : `credit_card_${threshold}_shown`,
      })
      .catch(() => undefined);
    write({ shown: threshold, answered: card?.answered ?? null });
  });
  const showing = visible ? owed : null;
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);

  if (showing == null || used == null || total == null || plan == null)
    return null;
  const count = tasksLeft(Math.max(0, total - used), mark?.perTask ?? null);
  const offer = milestoneOffer(plan, billing);
  const answer = (
    choice: "upgrade" | "top_up" | "next_plan" | "continue" | "switch_cheaper"
  ) => {
    console.info(`[credits] threshold card ${showing} answered: ${choice}`);
    void transport.client.system
      .funnelStep({
        step:
          plan === "paid"
            ? `credit_card_paid_${showing}_${choice === "upgrade" ? "next_plan" : choice}`
            : `credit_card_${showing}_${choice === "upgrade" ? "upgrade" : "continue"}`,
      })
      .catch(() => undefined);
    write({ shown: showing, answered: showing });
  };
  return (
    <CreditThresholdCard
      threshold={showing}
      used={used}
      total={total}
      estimate={count != null ? { count, kind: mark?.kind ?? null } : null}
      billing={billing ?? null}
      offer={offer}
      {...(project != null && { project })}
      onUpgrade={() => {
        // Inside the click: the web build opens its checkout tab here.
        void openUpgrade(transport.client, "low_credits");
        answer("upgrade");
      }}
      onNextPlan={() => {
        void openNextPlan(transport.client);
        answer("next_plan");
      }}
      onTopUp={() => {
        void openTopUp(transport.client);
        answer("top_up");
      }}
      {...(cheaper != null && latest != null && setChatModel != null
        ? {
            cheaper: {
              model: cheaper.target.label,
              onSwitch: () => {
                answer("switch_cheaper");
                void setChatModel(
                  db,
                  transport.client,
                  latest,
                  cheaper.target.id,
                  {
                    thisChatOnly: true,
                  }
                )
                  .then(() =>
                    showInfo(
                      t("creditThreshold.switchedCheaper", {
                        model: cheaper.target.label,
                      }),
                      {
                        description: t("creditThreshold.switchedCheaperBack", {
                          model: cheaper.current.label,
                        }),
                      }
                    )
                  )
                  .catch(() => showError(t("workspace.modelSwitchFailed")));
              },
            },
          }
        : {})}
      onContinue={() => answer("continue")}
    />
  );
};
