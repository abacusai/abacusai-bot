import { CONNECTORS } from "@abacus-ai/connectors/registry";
import type {
  ConnectorStatus,
  ConnectorStatuses,
} from "@abacus-ai/contract/contracts";
import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";

import { useAppContext } from "#renderer/lib/use-app-context";

import type { useConnectFlow } from "./connect-flow";
import {
  localAppHidden,
  localAppReason,
  type LocalAppReason,
} from "./local-app";

/** Abacus could not be read and nothing was known before: neither connected nor not. */
export const uncheckable = (status: ConnectorStatus | undefined): boolean =>
  status?.state === "unavailable" && status?.reason === "unavailable";
/** Read from Abacus last time rather than now, or not read at all. */
const unconfirmed = (statuses: ConnectorStatuses | undefined) => {
  const all = Object.values(statuses ?? {});
  return {
    stale: all.some((status) => status.stale === true),
    unchecked: all.some(uncheckable),
  };
};
/** While Abacus cannot be read, the list asks again on its own this often. */
const UNCONFIRMED_REFETCH_MS = 15_000;
export const useConnectorStatuses = (
  flow: Pick<ReturnType<typeof useConnectFlow>, "store">
) => {
  const { transport } = useAppContext();
  const statuses = useQuery({
    ...transport.orpc.connectors.statuses.queryOptions({ input: {} }),
    staleTime: 60000,
    // Only while the shown state is not a fresh read: back to fresh once Abacus answers.
    refetchInterval: (query) => {
      const { stale, unchecked } = unconfirmed(query.state.data);
      return stale || unchecked ? UNCONFIRMED_REFETCH_MS : false;
    },
  });
  const { stale, unchecked } = unconfirmed(statuses.data);
  // Abacus answers again: a Connect that could not reach it is no longer the news.
  const reachable = statuses.data != null && !stale && !unchecked;
  useEffect(() => {
    if (reachable)
      flow.store.setState((state) =>
        state.error === "unreachable" ? { ...state, error: undefined } : state
      );
  }, [reachable, flow.store]);
  return { statuses, stale, unchecked };
};
/**
 * What this account can add; chat apps only where they can pair, and an
 * app's own server only where that app runs.
 */
export const offeredConnectors = (
  statuses: ConnectorStatuses | undefined,
  messaging: boolean
) =>
  CONNECTORS.filter(
    (e) =>
      (messaging || e.kind !== "messaging") &&
      statuses?.[e.id]?.reason !== "not-offered" &&
      !localAppHidden(e, statuses?.[e.id])
  );
/** A linked chat app paused while this computer is offline: nothing to connect. */
export const pausedOffline = (status: ConnectorStatus | undefined): boolean =>
  status?.reason === "offline";

export const connectorAdded = (status: ConnectorStatus | undefined): boolean =>
  ["connected", "pending"].includes(status?.state ?? "");

/** What an added connector needs before it works. */
export type ConnectorFix = "offline" | "sign-in" | LocalAppReason | "reconnect";
/**
 * Null only when it works. Added but not working always names a fix; one with
 * no fix of its own (a chat app whose link broke) is connected again.
 */
export const connectorFix = (
  status: ConnectorStatus | undefined
): ConnectorFix | null => {
  if (status?.state !== "pending") return null;
  if (pausedOffline(status)) return "offline";
  if (status.reason === "sign-in-required") return "sign-in";
  return localAppReason(status) ?? "reconnect";
};
