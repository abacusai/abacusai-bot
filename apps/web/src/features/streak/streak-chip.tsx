/**
 * The daily streak on the home screen: a chip with the streak and today's
 * extra credits, opening a panel with the week, today's credits, the
 * full-week bonus and how it works. Shown only while the platform sends a
 * streak (a new free account's first days); nothing when it stops.
 */
import type { AbacusStreak } from "@abacus-ai/contract/contracts";
import { streakCreditsLeft } from "@abacus-ai/contract/streak";
import { cn } from "cn";
import { Gift } from "lucide-react";
import { useTranslation } from "react-i18next";

import { useAccount } from "#renderer/lib/use-account";
import { useAppContext } from "#renderer/lib/use-app-context";
import { useNow } from "#renderer/lib/use-now";
import { Popover, PopoverContent, PopoverTrigger } from "#renderer/ui/popover";

import { StreakFlame, StreakWeek } from "./streak-week";

const useNumber = () => {
  const { i18n } = useTranslation();
  const format = new Intl.NumberFormat(i18n.language);
  return (value: number) => format.format(value);
};

/** The panel's lines: the streak, the week, today's credits, the bonus, how it works. */
export const StreakPanel = ({
  streak,
  now,
}: {
  streak: AbacusStreak;
  now: number;
}) => {
  const { t } = useTranslation();
  const number = useNumber();
  const left = streakCreditsLeft(streak, now);
  return (
    <div data-slot="streak-panel" className="flex flex-col gap-3 p-1">
      <div className="flex items-center gap-2.5">
        <span className="flex size-9 items-center justify-center rounded-full bg-orange-100 dark:bg-orange-950/60">
          <StreakFlame lit={streak.streak > 0} className="size-5" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold">
            {streak.streak > 0
              ? t("streak.chip", { count: streak.streak })
              : t("streak.chipStart")}
          </p>
          <p className="text-muted-foreground">
            {t("streak.best", { count: Math.max(streak.best, streak.streak) })}
          </p>
        </div>
      </div>
      <StreakWeek streak={streak} now={now} />
      <div className="bg-muted/60 flex flex-col gap-1.5 rounded-md p-2.5">
        <div className="flex items-baseline justify-between gap-2">
          <span className="font-medium">{t("streak.todayCredits")}</span>
          <span data-slot="streak-today-left" className="font-semibold">
            {t("streak.todayLeft", {
              left: number(left),
              total: number(streak.daily_credits),
            })}
          </span>
        </div>
        <div
          role="progressbar"
          aria-label={t("streak.todayCredits")}
          aria-valuemin={0}
          aria-valuemax={streak.daily_credits}
          aria-valuenow={left}
          className="bg-background h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="h-full rounded-full bg-orange-500"
            style={{
              width: `${streak.daily_credits > 0 ? (left / streak.daily_credits) * 100 : 0}%`,
            }}
          />
        </div>
        {streak.bonus_state !== "missed" && (
          <p
            data-slot="streak-bonus"
            className={cn(
              "flex items-center gap-1.5",
              streak.bonus_state === "added"
                ? "font-medium text-orange-700 dark:text-orange-300"
                : "text-muted-foreground"
            )}
          >
            <Gift aria-hidden className="size-3.5 shrink-0" />
            {streak.bonus_state === "added"
              ? t("streak.bonusAdded", {
                  credits: number(streak.bonus_credits),
                })
              : streak.bonus_in_days != null && streak.bonus_in_days > 0
                ? t("streak.bonusIn", {
                    credits: number(streak.bonus_credits),
                    count: streak.bonus_in_days,
                  })
                : t("streak.bonusToday", {
                    credits: number(streak.bonus_credits),
                  })}
          </p>
        )}
      </div>
      <ul className="text-muted-foreground flex list-disc flex-col gap-1 ps-4">
        <li>{t("streak.howKeep")}</li>
        <li>
          {t("streak.howCredits", { credits: number(streak.daily_credits) })}
        </li>
        <li>{t("streak.howMidnight")}</li>
      </ul>
    </div>
  );
};

/** Under the home heading while the platform sends a streak. */
export const StreakChip = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  const number = useNumber();
  const now = useNow();
  const { data: account } = useAccount();
  const streak = account?.streak ?? null;
  if (streak == null) return null;
  const left = streakCreditsLeft(streak, now);
  return (
    <Popover
      onOpenChange={(open) => {
        if (open)
          void transport.client.system
            .funnelStep({ step: "streak_panel_opened", detail: "home" })
            .catch(() => undefined);
      }}
    >
      <PopoverTrigger
        render={
          <button
            type="button"
            data-slot="streak-chip"
            className="mx-auto flex items-center gap-1.5 rounded-full border border-orange-200 bg-orange-50 px-3 py-1 text-xs font-medium text-orange-900 transition-colors hover:bg-orange-100 dark:border-orange-900/70 dark:bg-orange-950/40 dark:text-orange-100 dark:hover:bg-orange-950/70"
          />
        }
      >
        <StreakFlame lit={streak.streak > 0} />
        <span>
          {streak.streak > 0
            ? t("streak.chip", { count: streak.streak })
            : t("streak.chipStart")}
        </span>
        {left > 0 && (
          <>
            <span aria-hidden className="opacity-50">
              ·
            </span>
            <span>{t("streak.chipCredits", { credits: number(left) })}</span>
          </>
        )}
      </PopoverTrigger>
      <PopoverContent side="bottom" align="center" className="w-80">
        <StreakPanel streak={streak} now={now} />
      </PopoverContent>
    </Popover>
  );
};
