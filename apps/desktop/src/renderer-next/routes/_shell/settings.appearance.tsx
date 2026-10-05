import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AppearanceTheme } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const AppearanceSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <AppearanceTheme />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  component: AppearanceSettingsRoute,
});
