/**
 * The daily streak's pieces shared by the home chip's panel and the card under
 * a reply: the flame, and the week as a row of days.
 */
import type { AbacusStreak } from "@abacus-ai/contract/contracts";
import { cn } from "cn";
import { Check, Flame } from "lucide-react";
import { useTranslation } from "react-i18next";

export const StreakFlame = ({
  lit = true,
  className,
}: {
  lit?: boolean;
  className?: string;
}) => (
  <Flame
    aria-hidden
    className={cn(
      "size-4 shrink-0",
      lit
        ? "fill-orange-400 text-orange-500 dark:fill-orange-500/80 dark:text-orange-400"
        : "text-muted-foreground",
      className
    )}
  />
);

/** The weekday of each day of the week, from today's place in it. */
const weekdays = (
  streak: AbacusStreak,
  now: number,
  language: string
): string[] => {
  const format = new Intl.DateTimeFormat(language, { weekday: "narrow" });
  return streak.week.map((_, index) =>
    format.format(new Date(now + (index - (streak.day - 1)) * 86_400_000))
  );
};

export const StreakWeek = ({
  streak,
  now,
}: {
  streak: AbacusStreak;
  now: number;
}) => {
  const { t, i18n } = useTranslation();
  const labels = weekdays(streak, now, i18n.language);
  return (
    <ol data-slot="streak-week" className="flex justify-between gap-1">
      {streak.week.map((state, index) => (
        <li
          key={index}
          data-state={state}
          className="flex flex-col items-center gap-1"
          aria-label={t(`streak.dayState.${state}`, { day: labels[index] })}
        >
          <span
            className={cn(
              "flex size-7 items-center justify-center rounded-full border text-[11px] font-semibold",
              state === "done" &&
                "border-orange-500 bg-orange-500 text-white dark:border-orange-400 dark:bg-orange-500",
              state === "today" &&
                "border-2 border-dashed border-orange-400 text-orange-600 dark:text-orange-300",
              state === "missed" &&
                "border-muted-foreground/25 bg-muted text-muted-foreground",
              state === "later" &&
                "border-muted-foreground/25 text-muted-foreground"
            )}
          >
            {state === "done" ? (
              <Check aria-hidden className="size-3.5" strokeWidth={3} />
            ) : state === "today" ? (
              <StreakFlame lit={false} className="size-3.5 text-orange-500" />
            ) : null}
          </span>
          <span aria-hidden className="text-muted-foreground text-[10px]">
            {labels[index]}
          </span>
        </li>
      ))}
    </ol>
  );
};
