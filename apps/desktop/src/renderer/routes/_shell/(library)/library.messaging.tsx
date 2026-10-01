import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { MessagingPage, MessagingSearch } from "#renderer/features/library";
import { TopBarSlot } from "#renderer/features/shell";

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
