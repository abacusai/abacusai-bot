import { useMemo } from "react";

import { CONNECTORS } from "../connectors";
import { isConnected, useConnectorStatuses } from "./use-connector-statuses";

/**
 * Which connectors this user has connected, in the registry's order, from
 * main's one status table. Connected means a live socket, a scanned QR, a
 * stored token, or a service the platform lists as attached; never a stored
 * enable flag, which outlives its own credentials.
 */
export const useConnectedConnectors = (): string[] => {
  const { statuses } = useConnectorStatuses();

  return useMemo(
    () =>
      CONNECTORS.filter((connector) => isConnected(statuses, connector.id)).map(
        (connector) => connector.id
      ),
    [statuses]
  );
};
