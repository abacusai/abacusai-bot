import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NotificationsPage } from "#renderer/features/settings/personal";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const NotificationsSettingsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("settings.pages.notifications")}
        </span>
      </TopBarSlot>
      <NotificationsPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/settings/notifications")({
  component: NotificationsSettingsRoute,
});
