import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { MessagingPage } from "#renderer/features/library/messaging";
import { MessagingSearch } from "#renderer/features/library/search";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const MessagingRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.messaging")}
        </span>
      </TopBarSlot>
      <MessagingPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/messaging")({
  validateSearch: MessagingSearch,
  component: MessagingRoute,
});
