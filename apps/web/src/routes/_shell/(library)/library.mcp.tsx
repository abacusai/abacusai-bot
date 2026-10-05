import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { McpPage } from "#renderer/features/library/mcp";
import { McpSearch } from "#renderer/features/library/search";
import { TopBarSlot } from "#renderer/features/shell/top-bar-slots";

const McpRoute = () => {
  const { t } = useTranslation();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.mcp")}
        </span>
      </TopBarSlot>
      <McpPage />
    </>
  );
};

export const Route = createFileRoute("/_shell/(library)/library/mcp")({
  validateSearch: McpSearch,
  component: McpRoute,
});
