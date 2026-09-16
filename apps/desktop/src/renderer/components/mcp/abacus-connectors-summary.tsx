import type { JSX } from "react";
import { useTranslation } from "react-i18next";

import type { ConnectorStatuses } from "#shared/contracts";

import { CONNECTORS, type PlatformConnector } from "../../connectors";
import { useConnectorStatuses } from "../../hooks/use-connector-statuses";
import { ConnectorLogo } from "../settings/connector-logo";

/**
 * The platform connectors behind the `abacus-connectors` MCP server, by name:
 * a bare "3 tools" pill says nothing to someone who connected nothing here.
 * Registry entries only — the registry is the allowlist, so a service
 * attached elsewhere that this app does not take is not behind this server.
 */
export const AbacusConnectorsSummary = (): JSX.Element => {
  const { t } = useTranslation();
  const { statuses, loaded } = useConnectorStatuses();

  if (!loaded)
    return (
      <div
        className="text-muted-foreground mt-1 text-xs"
        data-id="mcp-abacus-connectors-loading"
      >
        {t("mcpManagement.abacusConnectors.loading")}
      </div>
    );

  // No listing at all (signed out, platform unreachable) is not "none
  // attached": every platform entry reads unavailable then.
  const platformEntries = CONNECTORS.filter(
    (connector): connector is PlatformConnector => connector.kind === "platform"
  );
  const unreadable = platformEntries.every((connector) => {
    const status = statuses[connector.id];
    return (
      status == null ||
      (status.state === "unavailable" && status.reason !== "not-offered")
    );
  });
  if (unreadable)
    return (
      <div
        className="text-muted-foreground mt-1 text-xs"
        data-id="mcp-abacus-connectors-unavailable"
      >
        {t("mcpManagement.abacusConnectors.unavailable")}
      </div>
    );

  const rows = connectedRows(statuses);
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
        {rows.map((connector) => (
          <li
            key={connector.service}
            className="bg-muted/60 text-foreground inline-flex items-center gap-1.5 rounded px-1.5 py-0.5 text-xs"
            data-id={`mcp-abacus-connector-${connector.service}`}
            title={statuses[connector.id]?.account}
          >
            <span className="inline-flex size-4 items-center justify-center [&_img]:h-4 [&_img]:w-4">
              <ConnectorLogo connector={connector} />
            </span>
            {connector.name}
          </li>
        ))}
      </ul>
    </div>
  );
};

/** Attached platform connectors, in registry order. */
export const connectedRows = (
  statuses: ConnectorStatuses
): PlatformConnector[] =>
  CONNECTORS.filter(
    (connector): connector is PlatformConnector =>
      connector.kind === "platform" &&
      statuses[connector.id]?.state === "connected"
  );
