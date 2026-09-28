import { queryOptions, useQuery } from "@tanstack/react-query";

import { workspaceQueryKeys } from "../lib/query-keys";

/** How often the account is re-read with nothing else prompting it. */
export const ACCOUNT_REFETCH_MS = 5 * 60_000;

export const abacusAccountQueryOptions = (refresh = false) =>
  queryOptions({
    queryKey: workspaceQueryKeys.abacusAccount,
    queryFn: () => window.api.agent.getAbacusAccount(refresh),
    staleTime: 60_000,
    // Credits are spent outside this window too (bots, routines, the web
    // app), so the number is re-read on a schedule as well as after a turn.
    refetchInterval: ACCOUNT_REFETCH_MS,
  });

export const useAbacusAccountQuery = () =>
  useQuery(abacusAccountQueryOptions());
