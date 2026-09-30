import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { LibraryPageEmpty } from "#next/features/library";
import { TopBarSlot } from "#next/features/shell";

const ToolsRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.tools")}
        </span>
      </TopBarSlot>
      <LibraryPageEmpty page="tools" />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/tools/")({
  component: ToolsRoute,
});
