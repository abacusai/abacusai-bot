/**
 * Desktop routines run only while the computer is on and the app is open; a
 * paid plan runs them 24/7 in Abacus AI Agent on the web. What the Routines
 * area says about that, the one action it offers for it, and the card that
 * sends a new upgrade there.
 */
import type { RoutineMissed } from "@abacus-ai/contract/routines";
import { useLiveQuery } from "@tanstack/react-db";
import type { TFunction } from "i18next";
import {
  ArrowUpRight,
  MessageSquare,
  Moon,
  Repeat,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";

import { useCollections } from "#renderer/data/db";
import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import type { AppClient } from "#renderer/data/transport/types";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { creditsTier } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { showInfo } from "#renderer/lib/toast";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Dialog, DialogContent, DialogTitle } from "#renderer/ui/dialog";

import { routineOwns } from "./notify";

export type AlwaysOnPlan = "free" | "paid";

/** The plan to speak to on the desktop; null on the web or while it is unknown. */
const alwaysOnPlan = (
  account: Parameters<typeof creditsTier>[0]
): AlwaysOnPlan | null => {
  const tier = creditsTier(account);
  return !IS_ELECTRON || tier === "unknown"
    ? null
    : tier === "free"
      ? "free"
      : "paid";
};

const useAlwaysOnPlan = (): AlwaysOnPlan | null =>
  alwaysOnPlan(useAccount().data);

/** Opens Abacus AI Agent on the web, where a paid plan sets up its 24/7 routines. */
const openWebRoutines = (client: AppClient) =>
  void platformSystem(client).openExternal({ url: ABACUS_AGENT_URL });

/** Free: the upgrade flow. Paid: Abacus AI Agent on the web, where they set it up. */
const alwaysOnAction = (
  plan: AlwaysOnPlan,
  client: AppClient,
  t: TFunction
): { label: string; run(): void } =>
  plan === "free"
    ? {
        label: t("routines.hosted.upgrade"),
        run: () => void openUpgrade(client, "app_routines"),
      }
    : {
        label: t("routines.alwaysOn.openAgent"),
        run: () => openWebRoutines(client),
      };

const AlwaysOnButton = ({
  plan,
  variant,
}: {
  plan: AlwaysOnPlan;
  variant?: "default" | "outline";
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const action = alwaysOnAction(plan, transport.client, t);
  return (
    <Button size="sm" variant={variant} onClick={action.run}>
      {plan === "free" ? <Sparkles aria-hidden /> : null}
      {action.label}
      {plan === "paid" ? <ArrowUpRight aria-hidden /> : null}
    </Button>
  );
};

/** The quiet line under the Routines header: where these routines run. */
export const RoutinesWhereLine = () => {
  const { t } = useTranslation();
  if (!IS_ELECTRON) return null;
  return <span className="block">{t("routines.alwaysOn.local")}</span>;
};

/**
 * The "Run around the clock" card itself, for the plan it speaks to. Only the
 * paid card can be closed: the free one is the routines upgrade, always shown.
 */
export const RoutinesAlwaysOnCardView = ({
  plan,
  onDismiss,
}: {
  plan: AlwaysOnPlan;
  onDismiss: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <section
      aria-label={t("routines.alwaysOn.title")}
      data-testid="routines-always-on"
      className="bg-background flex w-full items-start gap-3 rounded-2xl border p-4 text-start"
    >
      <span
        aria-hidden
        className="bg-muted text-muted-foreground flex size-8 shrink-0 items-center justify-center rounded-[10px]"
      >
        <Moon className="size-4" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
        <div className="flex flex-col gap-0.5">
          <h2 className="text-sm font-medium">
            {t("routines.alwaysOn.title")}
          </h2>
          <p className="text-muted-foreground text-xs leading-snug">
            {t(
              plan === "free"
                ? "routines.alwaysOn.free"
                : "routines.alwaysOn.paid"
            )}
          </p>
        </div>
        <AlwaysOnButton plan={plan} />
      </div>
      {plan === "paid" && (
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t("routines.alwaysOn.dismiss")}
          onClick={onDismiss}
        >
          <X />
        </Button>
      )}
    </section>
  );
};

/**
 * "Run around the clock" on the Routines landing: always for a free plan
 * (an earlier dismissal no longer hides it), until dismissed for a paid one.
 */
export const RoutinesAlwaysOnCard = () => {
  const prefs = usePrefs();
  const update = useUpdatePrefs();
  const plan = useAlwaysOnPlan();
  if (
    plan == null ||
    (plan === "paid" && prefs.dismissals.routinesAlwaysOnCardAt != null)
  )
    return null;
  return (
    <RoutinesAlwaysOnCardView
      plan={plan}
      onDismiss={() =>
        void update({
          dismissals: { routinesAlwaysOnCardAt: Date.now() },
        }).catch(() => undefined)
      }
    />
  );
};

/** What a paid plan runs 24/7 on the web, as the upgrade card lists it. */
const WebRoutineRow = ({ icon, text }: { icon: ReactNode; text: string }) => (
  <li className="flex items-center gap-2.5 text-sm/5">
    <span
      aria-hidden
      className="bg-muted text-muted-foreground flex size-7 shrink-0 items-center justify-center rounded-lg"
    >
      {icon}
    </span>
    <span>{text}</span>
  </li>
);

/**
 * The after-upgrade card: the plan by name (`planName`, null when unknown),
 * what runs 24/7 on the web, Set up 24/7 routines and Back to AbacusAI Bot.
 * Esc and an outside click are Back.
 */
export const UpgradeRoutinesDialog = ({
  open,
  planName,
  onSetUp,
  onBack,
}: {
  open: boolean;
  planName: string | null;
  onSetUp: () => void;
  onBack: () => void;
}) => {
  const { t } = useTranslation();
  return (
    <Dialog open={open} onOpenChange={(next) => !next && onBack()}>
      {open && (
        <DialogContent
          showCloseButton={false}
          data-slot="upgrade-routines"
          className="gap-5 p-7 pb-5 text-sm sm:max-w-[420px] [&>*]:min-w-0"
        >
          <div className="flex flex-col items-center gap-3 text-center">
            <span
              aria-hidden
              className="bg-primary text-primary-foreground flex size-12 items-center justify-center rounded-[14px]"
            >
              <Moon className="size-6" />
            </span>
            <DialogTitle className="text-[22px]/7 font-semibold tracking-[-0.01em] text-balance">
              {planName
                ? t("routines.upgraded.title", { plan: planName })
                : t("routines.upgraded.titleNoPlan")}
            </DialogTitle>
            <p className="text-muted-foreground text-sm/[21px]">
              {t("routines.upgraded.body")}
            </p>
          </div>
          <ul className="flex flex-col gap-2.5">
            <WebRoutineRow
              icon={<MessageSquare className="size-4" />}
              text={t("routines.upgraded.autoReplies")}
            />
            <WebRoutineRow
              icon={<Repeat className="size-4" />}
              text={t("routines.upgraded.allRoutines")}
            />
          </ul>
          <div className="flex flex-col gap-1.5 pt-1">
            <Button className="h-11 text-sm font-semibold" onClick={onSetUp}>
              {t("routines.upgraded.setUp")}
              <ArrowUpRight aria-hidden />
            </Button>
            <Button
              variant="ghost"
              className="text-muted-foreground h-10 text-sm"
              onClick={onBack}
            >
              {t("routines.upgraded.back")}
            </Button>
          </div>
        </DialogContent>
      )}
    </Dialog>
  );
};

/**
 * Once, right after an upgrade: set up routines in Abacus AI Agent on the
 * web, where they run 24/7 with the computer off. An upgrade is a paid read
 * after this app first read the account as free; both marks live in prefs,
 * so an upgrade made while the app was closed is told on the next start.
 */
export const UpgradeRoutinesCard = () => {
  const { transport } = useAppContext();
  const collections = useCollections();
  const prefs = useLiveQuery(collections.prefs).data?.[0];
  const update = useUpdatePrefs();
  const account = useAccount().data;
  const plan = alwaysOnPlan(account);
  const freeSeenAt = prefs?.dismissals.freePlanSeenAt ?? null;
  useEffect(() => {
    // Read before writing: unread prefs would stamp an account seen before.
    if (prefs == null || plan !== "free" || freeSeenAt != null) return;
    void update({ dismissals: { freePlanSeenAt: Date.now() } }).catch(
      () => undefined
    );
  }, [prefs, plan, freeSeenAt, update]);
  const seen = () =>
    void update({ dismissals: { upgradeRoutinesSeenAt: Date.now() } }).catch(
      () => undefined
    );
  return (
    <UpgradeRoutinesDialog
      open={
        prefs != null &&
        plan === "paid" &&
        freeSeenAt != null &&
        prefs.dismissals.upgradeRoutinesSeenAt == null
      }
      planName={account?.plan ?? null}
      onSetUp={() => {
        openWebRoutines(transport.client);
        seen();
      }}
      onBack={seen}
    />
  );
};

/** On a routine's page: the fires it last missed while the computer was off. */
export const MissedRunsNote = ({ missed }: { missed: RoutineMissed }) => {
  const { t } = useTranslation();
  const plan = useAlwaysOnPlan();
  if (!IS_ELECTRON) return null;
  return (
    <div className="flex flex-col items-start gap-2 text-xs">
      <p className="text-muted-foreground">
        {t("routines.alwaysOn.missed", { count: missed.count })}
      </p>
      {plan != null && <AlwaysOnButton plan={plan} variant="outline" />}
    </div>
  );
};

/**
 * One notice for the fires routines missed while the computer was off, once
 * per finding (`missed.at`), whichever window is open when it lands.
 */
export const RoutinesMissedNotice = () => {
  const { t, i18n } = useTranslation();
  const { transport } = useAppContext();
  const collections = useCollections();
  const prefs = useLiveQuery(collections.prefs).data?.[0];
  const routines = useLiveQuery(collections.routines).data;
  const update = useUpdatePrefs();
  const shown = useRef(0);
  const seen = prefs?.dismissals.routinesMissedSeenAt ?? null;
  useEffect(() => {
    // Read before deciding: unread prefs would tell an old finding again.
    if (!IS_ELECTRON || prefs == null || routines == null) return;
    const fresh = routines.filter(
      (row) =>
        routineOwns(row) &&
        row.missed != null &&
        row.missed.at > Math.max(seen ?? 0, shown.current)
    );
    if (fresh.length === 0) return;
    const latest = Math.max(...fresh.map((row) => row.missed!.at));
    shown.current = latest;
    void update({ dismissals: { routinesMissedSeenAt: latest } }).catch(
      () => undefined
    );
    const names = new Intl.ListFormat(i18n.language, {
      type: "conjunction",
    }).format(fresh.map((row) => row.name));
    const count = fresh.reduce((sum, row) => sum + row.missed!.count, 0);
    // Read only now: the notice is rare, and its action depends on the plan.
    void transport.client.account
      .abacus({})
      .catch(() => null)
      .then((account) => {
        const plan = alwaysOnPlan(account);
        const action =
          plan == null ? null : alwaysOnAction(plan, transport.client, t);
        showInfo(t("routines.alwaysOn.missed", { count }), {
          description:
            plan == null
              ? names
              : t(
                  plan === "free"
                    ? "routines.alwaysOn.missedNoticeFree"
                    : "routines.alwaysOn.missedNoticePaid",
                  { names }
                ),
          timeout: 15_000,
          ...(action != null
            ? { action: { label: action.label, onClick: action.run } }
            : {}),
        });
      });
  }, [prefs, routines, seen, update, transport, t, i18n.language]);
  return null;
};
