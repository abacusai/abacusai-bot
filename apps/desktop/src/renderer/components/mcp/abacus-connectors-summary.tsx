import { useQuery } from "@tanstack/react-query";
import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import { CONNECTORS, type AbacusConnector } from "../../connectors";
import { abacusConnectorsQueryOptions } from "../../hooks/use-connected-connectors";
import { ConnectorLogo } from "../settings/connector-logo";

/**
 * The Abacus connectors behind the `abacus-connectors` MCP server, by name: a
 * bare "3 tools" pill says nothing to someone who connected nothing here.
 */
export const AbacusConnectorsSummary = (): JSX.Element => {
  const { t } = useTranslation();
  const query = useQuery(abacusConnectorsQueryOptions);
  const state = query.data;

  if (state == null)
    return (
      <div
        className="text-muted-foreground mt-1 text-xs"
        data-id="mcp-abacus-connectors-loading"
      >
        {t("mcpManagement.abacusConnectors.loading")}
      </div>
    );

  // No listing at all (signed out, platform unreachable) is not "none
  // attached": the query folds both into an empty set with no catalog.
  if (state.available == null)
    return (
      <div
        className="text-muted-foreground mt-1 text-xs"
        data-id="mcp-abacus-connectors-unavailable"
      >
        {t("mcpManagement.abacusConnectors.unavailable")}
      </div>
    );

  const rows = connectedRows(state.connected, state.names ?? {});
  if (rows.length === 0)
    return (
      <div
        className="text-muted-foreground mt-1 text-xs"
        data-id="mcp-abacus-connectors-none"
      >
        {t("mcpManagement.abacusConnectors.none")}
      </div>
    );

  return (
    <div className="mt-1.5" data-id="mcp-abacus-connectors">
      <div className="text-muted-foreground mb-1 text-xs">
        {t("mcpManagement.abacusConnectors.title", { count: rows.length })}
      </div>
      <ul className="flex flex-wrap gap-1.5">
        {rows.map((row) => (
          <li
            key={row.service}
            className="bg-muted/60 text-foreground inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs"
            data-id={`mcp-abacus-connector-${row.service}`}
            title={state.accounts?.[row.service]}
          >
            {row.connector != null && (
              <span className="inline-flex size-4 items-center justify-center [&_img]:h-4 [&_img]:w-4">
                <ConnectorLogo connector={row.connector} />
              </span>
            )}
            {row.name}
          </li>
        ))}
      </ul>
    </div>
  );
};

type ConnectedRow = {
  service: string;
  name: string;
  connector: AbacusConnector | null;
};

/** Attached services in catalog order, then unknown ones by platform name. */

export const connectedRows = (
  connected: Set<string>,
  names: Record<string, string>
): ConnectedRow[] => {
  const catalog = CONNECTORS.filter(
    (connector): connector is AbacusConnector => connector.auth === "abacus"
  );
  const rows: ConnectedRow[] = catalog
    .filter((connector) => connected.has(connector.abacusService))
    .map((connector) => ({
      service: connector.abacusService,
      name: connector.name,
      connector,
    }));
  const known = new Set(rows.map((row) => row.service));
  for (const service of [...connected].sort()) {
    if (known.has(service)) continue;
    rows.push({ service, name: names[service] ?? service, connector: null });
  }
  return rows;
};
