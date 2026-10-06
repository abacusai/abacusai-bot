import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { AppearancePage } from "#renderer/features/settings/appearance";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const AppearanceSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.appearance")}
        </span>
      </TopBarSlot>
      <AppearancePage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/appearance")({
  component: AppearanceSettingsRoute,
});
