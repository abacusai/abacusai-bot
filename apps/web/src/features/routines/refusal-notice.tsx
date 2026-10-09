import { useTranslation } from "react-i18next";

import {
  ABACUS_PLAN_URL,
  DESKTOP_DOWNLOAD_URL,
} from "#renderer/lib/abacus-links";
import { IS_BROWSER } from "#renderer/lib/platform";
import { openUpgrade } from "#renderer/lib/upgrade";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";

import type { RoutineRefusalText } from "./refusal";

export const RoutineRefusalNotice = ({
  refusal,
}: {
  refusal: RoutineRefusalText;
}) => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
  return (
    <div role="alert" className="flex flex-col gap-2 text-[13px]">
      <p>{t(refusal.key)}</p>
      {IS_BROWSER && refusal.upgrade && (
        <p className="text-muted-foreground">
          {t("web.routines.localAlternative")}
        </p>
      )}
      {refusal.upgrade && (
        <div className="flex flex-wrap gap-2">
          <Button
            size="sm"
            nativeButton={false}
            render={
              <a
                href={refusal.upgradeUrl ?? ABACUS_PLAN_URL}
                target="_blank"
                rel="noopener noreferrer"
              />
            }
            onClick={(event) => {
              if (refusal.upgradeUrl != null) return;
              event.preventDefault();
              void openUpgrade(transport.client);
            }}
          >
            {t("routines.hosted.upgrade")}
          </Button>
          {IS_BROWSER && (
            <Button
              size="sm"
              variant="outline"
              nativeButton={false}
              render={
                <a
                  href={DESKTOP_DOWNLOAD_URL}
                  target="_blank"
                  rel="noopener noreferrer"
                />
              }
            >
              {t("web.routines.download")}
            </Button>
          )}
        </div>
      )}
    </div>
  );
};
