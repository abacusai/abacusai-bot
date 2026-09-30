/** Public library navigation and feature components. */
import { useMatchRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { NavList } from "#next/components/nav-list";
import { LIBRARY_PAGES } from "#next/lib/navigation/areas";

export const LibrarySidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  return (
    <NavList.Root label={t("library.sidebar.label")}>
      <NavList.Header title={t("library.sidebar.label")} />
      <NavList.Rows>
        {LIBRARY_PAGES.map((page) => (
          <NavList.Item
            key={page}
            to={`/library/${page}`}
            active={
              matchRoute({ to: `/library/${page}`, fuzzy: true } as never) !==
              false
            }
            title={t(`library.pages.${page}`)}
          />
        ))}
      </NavList.Rows>
    </NavList.Root>
  );
};

export {
  ConnectorsPage,
  ConnectorSheet,
  ConnectorFieldsDialog,
} from "./connectors";
export { MessagingPage } from "./messaging";
export { McpPage } from "./mcp";
export { SkillsPage, ToolsPage, ToolsetPage } from "./skills-tools";
export { MessagingSearch, McpSearch, SkillsSearch } from "./search";
/** @public Connect flow shared with phase 6 onboarding. */
export { startConnect, useConnectFlow } from "./connect-flow";
export { LibraryGlobals } from "./globals";
