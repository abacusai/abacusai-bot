/**
 * Library, phase 1: static navigation (connectors, messaging, MCP servers,
 * skills, tools), an empty state per page and the search-driven connector
 * sheet (masked: the URL hides `connector`).
 */
import { useMatchRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { EmptyState } from "#next/components/empty-state";
import { NavList } from "#next/components/nav-list";
import { RouteSheet } from "#next/components/route-sheet";
import { LIBRARY_PAGES, type LibraryPageId } from "#next/lib/navigation/areas";

export type LibraryPage = LibraryPageId;

export const LibrarySidebar = () => {
  const { t } = useTranslation();
  const matchRoute = useMatchRoute();
  return (
    <NavList.Root label={t("library.sidebar.label")}>
      <NavList.Header title={t("library.sidebar.label")} />
      <div role="list" className="flex flex-col gap-0.5 pt-1">
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
      </div>
    </NavList.Root>
  );
};

export const LibraryPageEmpty = ({ page }: { page: LibraryPage }) => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="library"
      title={t(`library.pages.${page}`)}
      description={t("library.emptyDescription")}
    />
  );
};

export const ToolsetPage = ({ toolsetName }: { toolsetName: string }) => {
  const { t } = useTranslation();
  return (
    <EmptyState
      icon="library"
      title={toolsetName}
      description={t("library.emptyDescription")}
    />
  );
};

/** Open while `?connector=` is set; closing goes back (the mask hides it). */
export const ConnectorSheet = ({ connector }: { connector: string }) => {
  const { t } = useTranslation();
  return (
    <RouteSheet
      title={connector}
      description={t("library.connectorDescription")}
      fallbackHref="/library/connectors"
    />
  );
};
