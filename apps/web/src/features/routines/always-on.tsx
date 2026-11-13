/**
 * Desktop routines run only while the computer is on and the app is open; a
 * paid plan runs them 24/7 in Abacus AI Agent on the web. What the Routines
 * area says about that, and the one action it offers for it.
 */
import type { RoutineMissed } from "@abacus-ai/contract/routines";
import type { TFunction } from "i18next";
import { ArrowUpRight, Moon, Sparkles, X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { usePrefs, useUpdatePrefs } from "#renderer/data/db/prefs";
import type { AppClient } from "#renderer/data/transport/types";
import { ABACUS_AGENT_URL } from "#renderer/lib/abacus-links";
import { creditsTier } from "#renderer/lib/credits";
import { IS_ELECTRON } from "#renderer/lib/platform";
import { platformSystem } from "#renderer/lib/platform-system";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

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

export const useAlwaysOnPlan = (): AlwaysOnPlan | null =>
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

export const AlwaysOnButton = ({
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
