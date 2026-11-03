import {
  type BillingPlan,
  formatUsd,
  planPitch,
  wallOffer,
} from "@abacus-ai/contract/billing-plan";
import type { SessionRow } from "@abacus-ai/contract/contract/rows";
import {
  creditAccountKey,
  type CreditTaskKind,
  type CreditThreshold,
  creditThresholdWords,
  pendingThreshold,
  tasksLeft,
} from "@abacus-ai/contract/credit-thresholds";
import { useLiveQuery } from "@tanstack/react-db";
import { useQuery } from "@tanstack/react-query";
import { AlertTriangle, Check, Gauge } from "lucide-react";
import { useEffect, useEffectEvent } from "react";
import { useTranslation } from "react-i18next";

import { useCollections, useDb } from "#renderer/data/db";
import { usePrefs } from "#renderer/data/db/prefs";
import { creditsTier } from "#renderer/lib/credits";
import { openUpgrade } from "#renderer/lib/upgrade";
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
 * A free account's credit milestone card (contract credit-thresholds.ts):
 * half, then four fifths, of the free grant used. Over the window between
 * turns; it stays until a button is picked, and Esc is Continue free.
 */

export interface CreditThresholdCardProps {
  threshold: CreditThreshold;
  used: number;
  total: number;
  estimate: { count: number; kind: CreditTaskKind | null } | null;
  billing: BillingPlan | null;
  /** The chat the user is on, by its name: what running out would stop. */
  project?: string;
  onUpgrade(): void;
  onContinue(): void;
}

export const CreditThresholdCard = ({
  threshold,
  used,
  total,
  estimate,
  billing,
  project,
  onUpgrade,
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
    project
  );
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
            aria-label={t("creditThreshold.meterLabel", {
              used: number(used),
              total: number(total),
            })}
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
        <div className="flex flex-col gap-1.5">
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
          <Button
            variant="ghost"
            className="text-muted-foreground h-10 text-sm"
            data-action="continue-free"
            onClick={onContinue}
          >
            {t("creditThreshold.continueFree")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
};

/**
 * The card for the signed-in account's latest milestone, until it is
 * answered. A paid plan never sees it, nor a spent grant (the out-of-credits
 * card's), and it never opens over a running turn or the upgrade dialog.
 */
export const CreditThresholdHost = () => {
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
  // The chat the user worked in last, by its name; not a routine run's or a bot's.
  const project = (sessions ?? [])
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
    )
    ?.label.trim();
  const key = creditAccountKey(account);
  const mark = key != null ? prefs.creditThresholds?.[key] : undefined;
  const cards = prefs.dismissals.creditThresholdCards ?? {};
  const card = key != null ? cards[key] : undefined;
  const total = account?.credits_granted ?? null;
  // The account query can trail the read that stamped the mark.
  const used =
    account?.credits_used != null
      ? Math.max(
          account.credits_used,
          mark?.granted === total ? (mark?.used ?? 0) : 0
        )
      : null;
  // At the whole grant the out-of-credits card speaks instead.
  const owed =
    creditsTier(account) === "free" &&
    used != null &&
    total != null &&
    used < total
      ? pendingThreshold(mark, card)
      : null;
  // Once on screen it stays until answered, whatever starts behind it.
  const visible =
    owed != null && !upgradeAsked && (card?.shown === owed || !turnRunning);
  const { data: billing } = useQuery({
    ...transport.orpc.account.billingPlan.queryOptions({ input: {} }),
    enabled: owed != null,
    staleTime: 60_000,
  });

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
    void transport.client.system
      .funnelStep({ step: `credit_card_${threshold}_shown` })
      .catch(() => undefined);
    write({ shown: threshold, answered: card?.answered ?? null });
  });
  const showing = visible ? owed : null;
  useEffect(() => {
    if (showing != null) shown(showing);
  }, [showing]);

  if (showing == null || used == null || total == null) return null;
  const count = tasksLeft(Math.max(0, total - used), mark?.perTask ?? null);
  const answer = (choice: "upgrade" | "continue") => {
    void transport.client.system
      .funnelStep({ step: `credit_card_${showing}_${choice}` })
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
      {...(project != null && { project })}
      onUpgrade={() => {
        // Inside the click: the web build opens its checkout tab here.
        void openUpgrade(transport.client, "low_credits");
        answer("upgrade");
      }}
      onContinue={() => answer("continue")}
    />
  );
};
