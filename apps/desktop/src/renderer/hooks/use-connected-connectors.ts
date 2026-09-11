import { useQuery } from "@tanstack/react-query";
import { useMemo } from "react";

import {
  isMessagingPlatformConnected,
  useMessaging,
} from "../components/settings/messaging-connectors";
import { CONNECTORS } from "../connectors";
import { settingsQueryKeys } from "../lib/settings-query-keys";

/**
 * What the platform says is attached to this account. Shared, not declared
 * per caller: the connectors panel writes this shape back optimistically on
 * every attach, so a second reader with its own shape would read garbage.
 */
export type AbacusConnectorState = {
  connected: Set<string>;
  available: Set<string> | null;
  /** service key -> the platform's own name for it, for services the catalog lacks. */
  names?: Record<string, string>;
  /** service key -> who it is connected as ("Gmail - ada@example.com"). */
  accounts?: Record<string, string>;
};

export const abacusConnectorsQueryOptions = {
  queryKey: settingsQueryKeys.connectors.connectors,
  staleTime: 60_000,
  queryFn: async (): Promise<AbacusConnectorState> => {
    const snapshot = await window.api?.agent?.listAbacusConnectors?.();
    if (snapshot?.ok !== true) return { connected: new Set(), available: null };
    return {
      connected: new Set(Object.keys(snapshot.connected)),
      available: new Set(snapshot.available.map((item) => item.service)),
      names: Object.fromEntries(
        snapshot.available.map((item) => [item.service, item.name])
      ),
      accounts: snapshot.accounts,
    };
  },
};

/**
 * Which connectors this user has attached, in the catalog's order, merged
 * from the messaging gateway's snapshot and the platform's attached services.
 * Connected means a live socket, a scanned QR, or a service the platform
 * lists; never the stored enable flag, which outlives its own credentials.
 */
export const useConnectedConnectors = (): string[] => {
  const messaging = useMessaging();
  const abacusQuery = useQuery(abacusConnectorsQueryOptions);

  const snapshot = messaging.snapshot;
  const abacusConnected = abacusQuery.data?.connected;

  return useMemo(
    () =>
      CONNECTORS.filter((connector) =>
        connector.auth === "messaging"
          ? isMessagingPlatformConnected(snapshot, connector.messagingPlatform)
          : connector.auth === "abacus"
            ? abacusConnected?.has(connector.abacusService) === true
            : false
      ).map((connector) => connector.id),
    [abacusConnected, snapshot]
  );
};
