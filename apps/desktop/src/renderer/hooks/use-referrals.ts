import { queryOptions, useQuery } from "@tanstack/react-query";

import { workspaceQueryKeys } from "../lib/query-keys";

export const referralSummaryQueryOptions = () =>
  queryOptions({
    queryKey: workspaceQueryKeys.referralSummary,
    queryFn: () => window.api.agent.getReferralSummary(),
    staleTime: 60_000,
  });

/** The invite-friends loop for this account; null while signed out. */
export const useReferralSummaryQuery = () =>
  useQuery(referralSummaryQueryOptions());
