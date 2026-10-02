import { createFileRoute } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import { ConnectorSheet, LibraryPageEmpty } from "#next/features/library";
import { TopBarSlot } from "#next/features/shell";
import { ConnectorsSearch } from "#next/lib/navigation/search";

const ConnectorsRoute = () => {
  const { t } = useTranslation();
  const { connector } = Route.useSearch();
  return (
    <>
      <TopBarSlot>
        <span className="text-sidebar-foreground truncate font-medium">
          {t("library.pages.connectors")}
        </span>
      </TopBarSlot>
      <LibraryPageEmpty page="connectors" />
      {connector != null && <ConnectorSheet connector={connector} />}
    </>
  );
};

/** `?connector=` opens the sheet; the mask hides it from the URL. */
export const Route = createFileRoute("/_shell/(library)/library/connectors")({
  validateSearch: ConnectorsSearch,
  component: ConnectorsRoute,
});
