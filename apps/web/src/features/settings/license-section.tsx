import { lazy, Suspense, useState } from "react";
import { useTranslation } from "react-i18next";

import { GroupCard, SettingRow } from "#renderer/components/form-kit/page";
import { ABACUS_HELP_URL } from "#renderer/lib/abacus-links";
import { platformSystem } from "#renderer/lib/platform-system";
import { useAppContext } from "#renderer/lib/use-app-context";
import { Button } from "#renderer/ui/button";
import { Skeleton } from "#renderer/ui/skeleton";

const Licenses = lazy(() =>
  import("./licenses").then((module) => ({ default: module.Licenses }))
);
export const LicenseSection = () => {
  const { t } = useTranslation();
  const { transport } = useAppContext();
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
      <a
        className="text-muted-foreground self-start text-xs underline underline-offset-4"
        href={ABACUS_HELP_URL}
        target="_blank"
        rel="noopener noreferrer"
        onClick={(event) => {
          event.preventDefault();
          void platformSystem(transport.client).openExternal({
            url: ABACUS_HELP_URL,
          });
        }}
      >
        {t("profile.help")}
      </a>
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
