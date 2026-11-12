import { useTranslation } from "react-i18next";

import { CoachCard } from "#renderer/components/coach-card";
import { Button } from "#renderer/ui/button";

import { TOUR_STOPS, type TourStop } from "./stops";

export const TourCard = ({
  anchor,
  stop,
  index,
  onDismiss,
  onNext,
}: {
  anchor: HTMLElement;
  stop: TourStop;
  index: number;
  onDismiss(): void;
  onNext(): void;
}) => {
  const { t } = useTranslation();
  return (
    <CoachCard
      anchor={anchor}
      title={t(`tour.stops.${stop.id}.title`)}
      body={t(`tour.stops.${stop.id}.body`)}
      onDismiss={onDismiss}
      marker={{ "data-tour-stop": stop.id }}
      footer={
        <div className="flex items-center justify-between gap-3">
          <span className="text-muted-foreground">
            {t("tour.progress", {
              current: index + 1,
              total: TOUR_STOPS.length,
            })}
          </span>
          <Button data-tour-next onClick={onNext}>
            {t(index === TOUR_STOPS.length - 1 ? "tour.finish" : "tour.next")}
          </Button>
        </div>
      }
    />
  );
};
