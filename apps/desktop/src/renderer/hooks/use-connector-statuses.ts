import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";

import type { ConnectorStatus, ConnectorStatuses } from "#shared/contracts";

import { settingsQueryKeys } from "../lib/settings-query-keys";

/**
 * Every registry connector's status, from main's one table, re-read once
 * whenever main says something moved (`connector-status-changed`) — a key
 * stored, a platform attached, a chat app paired — and after a messaging or
 * credential change, which move statuses too. No surface computes
 * "installed" for itself any more.
 */
const EMPTY: ConnectorStatuses = {};

export const connectorStatusesQueryOptions = {
  queryKey: settingsQueryKeys.connectors.statuses,
  staleTime: 60_000,
  queryFn: async (): Promise<ConnectorStatuses> =>
    (await window.api?.agent?.listConnectorStatuses?.()) ?? EMPTY,
};

export const useConnectorStatuses = (): {
  statuses: ConnectorStatuses;
  /** Null until the first read lands: "not connected" is not the same as unknown. */
  loaded: boolean;
  refresh: () => Promise<void>;
} => {
  const queryClient = useQueryClient();
  const query = useQuery(connectorStatusesQueryOptions);

  useEffect(() => {
    const off = window.api?.agent?.onEvent?.((event) => {
      if (
        event.type === "connector-status-changed" ||
        event.type === "credentials-changed" ||
        event.type === "messaging-updated"
      )
        void queryClient.invalidateQueries({
          queryKey: settingsQueryKeys.connectors.statuses,
        });
    });
    return () => off?.();
  }, [queryClient]);

  return {
    statuses: query.data ?? EMPTY,
    loaded: query.data != null,
    refresh: async () => {
      await queryClient.invalidateQueries({
        queryKey: settingsQueryKeys.connectors.statuses,
      });
    },
  };
};

export const statusOf = (
  statuses: ConnectorStatuses,
  connectorId: string
): ConnectorStatus => statuses[connectorId] ?? { state: "available" };

export const isConnected = (
  statuses: ConnectorStatuses,
  connectorId: string
): boolean => statusOf(statuses, connectorId).state === "connected";
