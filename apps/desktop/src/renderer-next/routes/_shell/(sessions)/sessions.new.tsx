import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { SessionsNewPage } from "#next/features/sessions";
import { TopBarSlot } from "#next/features/shell";
import { NewSessionSearch } from "#next/lib/navigation/search";

const SessionsNewRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("sessions.page.newTitle")}
        </span>
      </TopBarSlot>
      <SessionsNewPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(sessions)/sessions/new")({
  validateSearch: NewSessionSearch,
  component: SessionsNewRoute,
});
