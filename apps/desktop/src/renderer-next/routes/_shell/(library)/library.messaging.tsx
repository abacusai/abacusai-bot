import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LibraryPageEmpty } from "#next/features/library";
import { TopBarSlot } from "#next/features/shell";

const MessagingRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.messaging")}
        </span>
      </TopBarSlot>
      <LibraryPageEmpty page="messaging" />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/messaging")({
  component: MessagingRoute,
});
