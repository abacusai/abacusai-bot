import { createFileRoute, stripSearchParams } from "@tanstack/react-router";
import { useTranslation } from "react-i18next";

import {
  ConnectorSheet,
  ConnectorsPage,
  ConnectorFieldsDialog,
} from "#renderer/features/library";
import { TopBarSlot } from "#renderer/features/shell";
import { ConnectorsSearch } from "#renderer/lib/navigation/search";

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
      <ConnectorsPage />
      <ConnectorFieldsDialog />
      {connector != null && <ConnectorSheet connector={connector} />}
    </>
  );
};

/** `?connector=` opens the sheet; the mask hides it from the URL. */
export const Route = createFileRoute("/_shell/(library)/library/connectors")({
  search: { middlewares: [stripSearchParams({ category: "featured" })] },
  validateSearch: ConnectorsSearch,
  component: ConnectorsRoute,
});
