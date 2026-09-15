import { queryOptions, useQuery } from "@tanstack/react-query";

import { canSignOutOfAbacus } from "#shared/settings";

import { settingsQueryKeys } from "../lib/settings-query-keys";

/**
 * Is an Abacus.AI key stored? Read locally, not from the network, so being
 * offline never reads as signed out. Refreshed by lib/credential-refresh.ts.
 */
export const abacusCredentialQueryOptions = () =>
  queryOptions({
    queryKey: settingsQueryKeys.models.abacusCredential,
    queryFn: async () =>
      canSignOutOfAbacus(await window.api.agent.getSettings()),
    staleTime: 60_000,
  });

export const useAbacusCredentialQuery = () =>
  useQuery(abacusCredentialQueryOptions());
