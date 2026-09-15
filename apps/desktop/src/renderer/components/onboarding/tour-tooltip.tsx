import {
  ArrowLeft,
  ArrowRight,
  Shapes,
  X,
  type LucideIcon,
} from "lucide-react";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";
import type { TooltipRenderProps } from "react-tourlight";

import { Button } from "../ui";
import {
  Card,
  CardAction,
  CardContent,
  CardFooter,
  CardHeader,
  CardTitle,
} from "../ui/card";
import { TOUR_STOPS, type TourStop } from "./tour-stops";

/** The tour's card. Tourlight supplies the copy and the controls; the stop table supplies the rest. */
export const TourTooltip = ({
  step,
  next,
  previous,
  skip,
  currentIndex,
  totalSteps,
}: TooltipRenderProps): JSX.Element => {
  const { t } = useTranslation();
  const isFirst = currentIndex === 0;
  const isLast = currentIndex === totalSteps - 1;
  const stop: Partial<TourStop> & { icon: LucideIcon } = TOUR_STOPS[
    currentIndex
  ] ?? { icon: Shapes };
  const Icon = stop.icon;

  return (
    <Card
      className="bg-card/85 w-[min(26rem,calc(100vw-2rem))] gap-5 rounded-2xl p-6 shadow-2xl backdrop-blur-2xl"
      data-id="welcome-tour-card"
      role="dialog"
      aria-modal="true"
    >
      <CardHeader className="grid-cols-[1fr_auto] items-start gap-3 p-0">
        {/* Above the title, not beside it: at this size a glyph on the
            title's baseline competes with it. */}
        <span className="bg-primary/10 text-primary flex size-12 items-center justify-center rounded-xl">
          <Icon className="size-6" />
        </span>
        <CardAction className="col-start-2 row-start-1 self-start">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={skip}
            data-id="welcome-tour-close"
            aria-label={t("tour.skip")}
          >
            <X />
          </Button>
        </CardAction>
        <div className="col-span-2 flex flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2.5">
            <CardTitle
              data-id="welcome-tour-title"
              className="text-2xl font-bold tracking-tight"
            >
              {step.title}
            </CardTitle>
            {stop.optional === true && (
              <span
                className="bg-primary/10 text-primary rounded-full px-2.5 py-0.5 text-xs font-semibold"
                data-id="welcome-tour-optional"
              >
                {t("tour.optional")}
              </span>
            )}
          </div>
          {stop.subtitleKey != null && (
            <p
              className="text-muted-foreground text-sm"
              data-id="welcome-tour-subtitle"
            >
              {t(stop.subtitleKey)}
            </p>
          )}
        </div>
      </CardHeader>

      <CardContent className="space-y-5 p-0">
        {stop.bullets == null ? (
          <p className="text-foreground/80 text-[15px] leading-relaxed">
            {step.content}
          </p>
        ) : (
          <div className="flex flex-col gap-4" data-id="welcome-tour-bullets">
            {stop.bullets.map((bullet) => {
              const BulletIcon = bullet.icon;
              return (
                <div key={bullet.bodyKey} className="flex items-start gap-3.5">
                  <span className="bg-primary/10 text-primary flex size-10 shrink-0 items-center justify-center rounded-xl">
                    <BulletIcon className="size-5" />
                  </span>
                  <p className="text-foreground/80 pt-1.5 text-[15px] leading-relaxed">
                    {t(bullet.bodyKey)}
                  </p>
                </div>
              );
            })}
          </div>
        )}
        <div
          role="progressbar"
          aria-valuemin={1}
          aria-valuemax={totalSteps}
          aria-valuenow={currentIndex + 1}
          className="bg-muted h-1.5 overflow-hidden rounded-full"
        >
          <div
            className="bg-primary h-full rounded-full transition-[width] duration-300"
            style={{ width: `${((currentIndex + 1) / totalSteps) * 100}%` }}
          />
        </div>
      </CardContent>

      <CardFooter className="justify-between gap-3 p-0">
        <span className="text-muted-foreground text-sm tabular-nums">
          {t("tour.progress", {
            current: currentIndex + 1,
            total: totalSteps,
          })}
        </span>
        <div className="flex items-center gap-2">
          {!isFirst && (
            <Button
              variant="outline"
              onClick={previous}
              data-id="welcome-tour-back"
              className="font-semibold"
            >
              <ArrowLeft />
              {t("common.back")}
            </Button>
          )}
          <Button
            onClick={next}
            data-id="welcome-tour-next"
            className="font-semibold"
          >
            {isLast ? t("tour.finish") : t("tour.next")}
            {!isLast && <ArrowRight />}
          </Button>
        </div>
      </CardFooter>
    </Card>
  );
};
