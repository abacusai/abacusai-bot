import "./tour.css";
import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Button } from "#renderer/ui/button";

import { TourCard } from "./card";
import { TOUR_STOPS } from "./stops";
export const TourGallery = ({ stop = "sessions" }: { stop?: string }) => {
  const { t } = useTranslation();
  const [anchor, setAnchor] = useState<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(true);
  const initial = Math.max(
    0,
    TOUR_STOPS.findIndex((item) => item.id === stop)
  );
  const [index, setIndex] = useState(initial);
  return (
    <>
      <Button
        ref={setAnchor}
        data-tour-active={open ? "" : undefined}
        onClick={() => setOpen(true)}
      >
        {t("tour.replay")}
      </Button>
      {open && anchor && (
        <TourCard
          anchor={anchor}
          stop={TOUR_STOPS[index]!}
          index={index}
          onDismiss={() => setOpen(false)}
          onNext={() =>
            index === TOUR_STOPS.length - 1
              ? setOpen(false)
              : setIndex(index + 1)
          }
        />
      )}
    </>
  );
};
