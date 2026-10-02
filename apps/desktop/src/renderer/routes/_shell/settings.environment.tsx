import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EnvironmentPage } from "#renderer/features/settings/environment";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const EnvironmentSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.environment")}
        </span>
      </TopBarSlot>
      <EnvironmentPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/environment")({
  component: EnvironmentSettingsRoute,
});
