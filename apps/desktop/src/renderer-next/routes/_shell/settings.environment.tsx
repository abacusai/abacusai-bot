import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EnvironmentPage } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const EnvironmentSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <EnvironmentPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/environment")({
  component: EnvironmentSettingsRoute,
});
