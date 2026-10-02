import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { GeneralPage } from "#renderer/features/settings/personal";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const GeneralSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.sidebar.label")}
        </span>
      </TopBarSlot>
      <GeneralPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/general")({
  component: GeneralSettingsRoute,
});
