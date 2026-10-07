import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard, SettingRow } from "#renderer/components/form-kit/page";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";

const Licenses = lazy(() =>
  import("./licenses").then((module) => ({ default: module.Licenses }))
);
export const LicenseSection = () => {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <GroupCard>
        <SettingRow
          id="openSourceLicenses"
          title={t("settings.licenses.title")}
          detail={t("settings.licenses.description")}
        >
          <Button
            size="sm"
            variant="secondary"
            aria-expanded={open}
            aria-controls="open-source-licenses"
            onClick={() => setOpen((value) => !value)}
          >
            {t(open ? "settings.licenses.hide" : "phase5.openAction")}
          </Button>
        </SettingRow>
        <SettingRow
          id="appLicense"
          title={t("settings.licenses.own")}
          detail={t("settings.licenses.attribution")}
        />
      </GroupCard>
      {open && (
        <div id="open-source-licenses">
          <Suspense fallback={<Skeleton className="h-32" />}>
            <Licenses />
          </Suspense>
        </div>
      )}
    </>
  );
};
