/**
 * The daily streak's card under the reply that made today count: the streak,
 * what tomorrow brings, and on the full week the bonus added.
 */
import type { AbacusStreak } from "@abacus-ai/contract/contracts";
import { X } from "lucide-react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

import { StreakFlame, StreakWeek } from "./streak-week";

export const StreakCard = ({
  streak,
  now,
  onClose,
}: {
  streak: AbacusStreak;
  now: number;
  onClose(): void;
}) => {
  const { t, i18n } = useTranslation();
  const number = new Intl.NumberFormat(i18n.language);
  const fullWeek =
    streak.bonus_state === "added" && streak.day === streak.week.length;
  const title = fullWeek
    ? t("streak.noteFullWeek")
    : streak.streak <= 1 && streak.best > 1
      ? t("streak.noteRestart")
      : t("streak.noteDay", { count: Math.max(streak.streak, 1) });
  const lastDay = streak.day >= streak.week.length;
  const body = fullWeek
    ? t("streak.noteBonusAdded", {
        credits: number.format(streak.bonus_credits),
      })
    : lastDay
      ? t("streak.noteToday")
      : t("streak.noteTomorrow", {
          credits: number.format(streak.daily_credits),
        });
  const bonusLine =
    !fullWeek &&
    streak.bonus_state === "pending" &&
    streak.bonus_in_days != null &&
    streak.bonus_in_days > 0
      ? t("streak.noteBonusIn", {
          credits: number.format(streak.bonus_credits),
          count: streak.bonus_in_days,
        })
      : null;
  return (
    <div
      data-slot="streak-note"
      data-day={streak.day}
      className="relative my-2 flex w-full max-w-[520px] gap-3 rounded-xl border border-orange-200 bg-orange-50/70 p-3.5 pr-9 text-sm dark:border-orange-900/70 dark:bg-orange-950/30"
    >
      <span
        aria-hidden
        className="flex size-8 shrink-0 items-center justify-center rounded-[9px] bg-orange-500 text-white"
      >
        <StreakFlame className="fill-white text-white dark:fill-white dark:text-white" />
      </span>
      <div className="flex min-w-0 flex-1 flex-col gap-2.5">
        <div className="flex flex-col gap-0.5">
          <p className="font-semibold">{title}</p>
          <p className="text-muted-foreground">{body}</p>
          {bonusLine != null && (
            <p className="text-muted-foreground">{bonusLine}</p>
          )}
        </div>
        <div className="max-w-[300px]">
          <StreakWeek streak={streak} now={now} />
        </div>
        <div>
          <Button
            size="sm"
            className="bg-orange-500 text-white hover:bg-orange-600"
            data-action="got-it"
            onClick={onClose}
          >
            {t("streak.noteCta")}
          </Button>
        </div>
      </div>
      <Button
        variant="ghost"
        size="icon"
        className="text-muted-foreground absolute top-2 right-2 size-7"
        aria-label={t("upgradeDialog.close")}
        data-action="close"
        onClick={onClose}
      >
        <X className="size-4" />
      </Button>
    </div>
  );
};
