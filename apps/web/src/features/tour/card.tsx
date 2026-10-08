import { X } from "lucide-react";
import { useEffect } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverDescription,
  PopoverTitle,
} from "#renderer/ui/popover";

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
  useEffect(() => {
    const dismiss = (event: KeyboardEvent) => {
      if (event.key === "Escape") onDismiss();
    };
    document.addEventListener("keydown", dismiss);
    return () => document.removeEventListener("keydown", dismiss);
  }, [onDismiss]);
  return (
    <Popover
      open
      modal={false}
      onOpenChange={(open) => {
        if (!open) onDismiss();
      }}
    >
      <PopoverContent
        anchor={anchor}
        side="right"
        sideOffset={12}
        initialFocus={false}
        finalFocus={false}
        className="max-w-[calc(100vw-32px)] p-4"
        data-tour-stop={stop.id}
      >
        <div className="flex items-center justify-between gap-3">
          <PopoverTitle>{t(`tour.stops.${stop.id}.title`)}</PopoverTitle>
          <Button
            size="icon-sm"
            variant="ghost"
            aria-label={t("common.close")}
            onClick={onDismiss}
          >
            <X />
          </Button>
        </div>
        <PopoverDescription>
          {t(`tour.stops.${stop.id}.body`)}
        </PopoverDescription>
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
      </PopoverContent>
    </Popover>
  );
};
