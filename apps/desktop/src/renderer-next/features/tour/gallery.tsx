import { useState } from "react";
import { useTranslation } from "react-i18next";

import { Spotlight } from "#next/components/spotlight";
import { Button } from "#next/ui/button";
export const TourGallery = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button onClick={() => setOpen(true)}>{t("tour.replay")}</Button>
      {open && (
        <Spotlight
          rect={{ x: 260, y: 220, width: 220, height: 80 }}
          onDismiss={() => setOpen(false)}
          titleId="gallery-tour-title"
          bodyId="gallery-tour-body"
        >
          <h2 id="gallery-tour-title">{t("tour.stops.welcome.title")}</h2>
          <p id="gallery-tour-body" className="my-4">
            {t("tour.stops.welcome.body", { n: 12 })}
          </p>
          <div className="flex gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              {t("tour.skip")}
            </Button>
            <Button data-tour-next onClick={() => setOpen(false)}>
              {t("tour.next")}
            </Button>
          </div>
        </Spotlight>
      )}
    </>
  );
};
