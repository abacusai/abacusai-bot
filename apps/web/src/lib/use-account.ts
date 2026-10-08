import { useQuery } from "@tanstack/react-query";

import { useAppContext } from "#renderer/lib/use-app-context";

/** Name, photo, plan and credits use the same account RPC on both platforms. */
export const useAccount = () => {
  const { transport } = useAppContext();
  return useQuery({
    ...transport.orpc.account.abacus.queryOptions({ input: { refresh: true } }),
    staleTime: 60_000,
    refetchInterval: 300_000,
  });
};
