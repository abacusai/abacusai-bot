import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { SettingsPageEmpty } from "#next/features/settings";
import { TopBarSlot } from "#next/features/shell";

const ModelsSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.models")}
        </span>
      </TopBarSlot>
      <SettingsPageEmpty page="models" />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/models")({
  component: ModelsSettingsRoute,
});
